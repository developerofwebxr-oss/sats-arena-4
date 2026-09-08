import * as THREE from 'three';
import { getTheme, onThemeChange } from './theme.js';
import { createTextSprite } from './vrui.js';

/**
 * vr-menu.js — in-world floating menu for immersive VR/AR.
 *
 * WHY: in a headset the DOM HUD isn't rendered, so a VR/AR player can't reach
 * CO-OP / Compete / approve-a-knock / Mute / Recenter / Exit / Leave. This
 * surfaces those same actions in-world. Every item delegates to the EXISTING
 * handler the DOM button uses — this module adds no game mechanics.
 *
 * OPEN/CLOSE: X on the LEFT controller (unified controller standard: X = menu).
 * Handled in xr.js's face-button poll. Flat/mobile never see this — everything
 * here gates on renderer.xr.isPresenting and on tracked-pointer controllers.
 *
 * PLACEMENT: on open the panel is dropped 1.5 m ahead of the head using head YAW
 * ONLY (pitch and roll discarded) at the head's world eye height, then faces the
 * player level. It is then WORLD-FIXED — it does not chase the head. Re-opening
 * (or RECENTER) re-drops it at the current pose.
 *
 * NOT A PAUSE: this is an overlay. It does not stop the render loop, the shared
 * co-op world, or the competition clock — all of which keep ticking in main.js.
 *
 * Performance: the whole panel is ONE canvas-textured quad (one draw call),
 * repainted only when its state signature changes — never per frame, matching
 * the redraw-on-change discipline in vrui.js. Hit-testing raycasts that single
 * quad and maps the hit UV to a row, so there are no extra hit-test meshes.
 */

// ── Palette — the game's existing in-world/HUD colours (scene.js, hud.js,
// vrui.js, competition.js). Nothing new is introduced here. ───────────────────
// P51: colours come from the active skin's theme, not from literals. The menu is
// a canvas texture, so unlike the DOM it cannot restyle itself when the theme
// changes — it has to be told, and it repaints (setupVrMenu subscribes below).
// `T` is read at DRAW time, never captured, so a repaint always uses the newest
// palette. Roles are unchanged; only the pigment moves.
let T = getTheme();
const CYAN     = () => T.primary;    // primary UI (SHOOT button, radar, session chip)
const MAGENTA  = () => T.accent;     // competition + rapid-fire (matches #cmp-compete)
const ORANGE   = () => T.glow;       // bitcoin accent (score, laser)
const GREEN    = () => T.ok;         // approve / connected
const RED      = () => T.danger;     // deny / destructive — stays red in every skin
const DIM      = () => T.textMuted;  // unavailable
// 0.96 rather than 0.92: at 1.5 m the Gold arena showed through enough to
// fight the header text. Still translucent, but the panel wins.
const PANEL_BG = () => T.alpha(T.panelBg, 0.96);

// ── Panel geometry ───────────────────────────────────────────────────────────
// 720x920 texture on a 0.88 m wide quad at 1.5 m. That works out at ~21.6 canvas
// px per degree of view against a Quest 2's ~20 px/deg, so one texel is roughly
// one display pixel — crisp without wasting memory. The panel subtends ~34deg
// wide by ~41deg tall, which fits inside a comfortable glance.
const CANVAS_W = 720;
// Height is set by the WORST CASE, not the common one: header + PLAY(4) +
// CO-OP(3 with reasons + a pending request) + the exit footer. Sizing for the
// solo state and letting the full state overflow is exactly what happened on the
// first pass — EXIT TO SCREEN was pushed off the bottom edge the moment someone
// knocked. layout() now warns in dev if content ever exceeds this again.
const CANVAS_H = 1060;
const PANEL_W  = 0.86;                              // metres
const PANEL_H  = PANEL_W * (CANVAS_H / CANVAS_W);   // 1.27 m ≈ 46deg tall at 1.5 m
const DISTANCE = 1.5;                               // metres ahead of the head

// ── Type scale ───────────────────────────────────────────────────────────────
// FOUR sizes and no more. The old menu mixed 38/34/26/24/19 px with no system,
// so nothing read as a hierarchy — it read as inconsistency. Every string below
// picks one of these, and the only thing that varies within a level is weight.
// The smallest, HINT at 18 px, is 0.83deg tall at 1.5 m — well above the ~0.5deg
// legibility floor, so even the quietest text is readable rather than decorative.
const F_BRAND   = 22;   // SATS ARENA wordmark
const F_CODE    = 62;   // the host code — the biggest thing on the panel, by design
const F_TITLE   = 28;   // row labels
const F_LABEL   = 19;   // section labels, meta, status
const F_HINT    = 18;   // the footer hint and inline reasons

// ── Vertical rhythm (canvas px) ──────────────────────────────────────────────
const PAD        = 26;  // panel inset
const ROW_H      = 54;
const ROW_REASON = 72;  // a row carrying an inline reason: label line + reason line
const ROW_GAP    = 6;
const SECTION_GAP = 12; // above a section label
const LABEL_H    = 22;

// ── Head-locked sprite offsets (metres from the head; -Z forward). Tunable
// on-device, same convention as vrui.js. ─────────────────────────────────────
const NOTICE_OFFSET = new THREE.Vector3(0,  0.88, -2.0); // knock notice / badge
const TOAST_OFFSET  = new THREE.Vector3(0,  0.02, -2.0); // gentle action toasts
const NOTICE_SECS   = 6.0;
const TOAST_SECS    = 2.8;

// Two-tap confirm window on LEAVE. Long enough to be a deliberate second tap,
// short enough that it cannot still be armed when you come back to the menu.
const CONFIRM_MS = 3000;

/**
 * @param scene     THREE.Scene
 * @param renderer  THREE.WebGLRenderer (XR-enabled)
 * @param deps      the EXISTING actions this menu drives (see main.js)
 */
export function setupVrMenu(scene, renderer, deps) {
  // ── The panel: one quad, one canvas texture ────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.width  = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);

  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(PANEL_W, PANEL_H),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }),
  );
  panel.name = 'VrMenuPanel';
  panel.visible = false;
  panel.renderOrder = 10; // draw after the world so it reads clearly in AR
  scene.add(panel);

  // ── Head-locked text sprites (same helper as the rest of the in-world HUD) ──
  const noticeSprite = createTextSprite(1.3, T.primary);
  const toastSprite  = createTextSprite(1.0, T.glow);
  noticeSprite.mesh.visible = false;
  toastSprite.mesh.visible  = false;
  noticeSprite.mesh.name = 'VrMenuNotice';
  toastSprite.mesh.name  = 'VrMenuToast';
  scene.add(noticeSprite.mesh, toastSprite.mesh);

  // ── State ──────────────────────────────────────────────────────────────────
  let open      = false;
  let view      = 'root';  // 'root' | 'skins' — the only sub-list in this pass
  let hoverId   = null;
  let lastSig   = null;
  let pending   = [];
  let seenReqId = null;
  let noticeUntil = 0;
  let toastUntil  = 0;
  let confirmUntil = 0;    // LEAVE is armed until this timestamp
  let rows = [];           // the laid-out model; draw AND hit-test both read it

  onThemeChange((t) => {
    T = t;
    noticeSprite.setColor(t.primary);
    toastSprite.setColor(t.glow);
    lastSig = null;        // force a repaint with the new palette
  });

  const raycaster = new THREE.Raycaster();
  const _camPos  = new THREE.Vector3();
  const _camQuat = new THREE.Quaternion();
  const _fwd     = new THREE.Vector3();
  const _offset  = new THREE.Vector3();
  const _origin  = new THREE.Vector3();
  const _dir     = new THREE.Vector3();

  // ── Pending join requests → in-world notice + badge ────────────────────────
  deps.onPendingRequests((list) => {
    pending = list || [];
    const top = pending[0];
    if (top && top.requestId !== seenReqId) {
      seenReqId = top.requestId;
      noticeSprite.setText(`${top.requesterName || 'Someone'} wants to join\npress X to open the menu`);
      noticeUntil = performance.now() + NOTICE_SECS * 1000;
    }
    if (!top) seenReqId = null;
  });

  // ── The information architecture ───────────────────────────────────────────
  /**
   * Build the menu as SECTIONS grouped by intent, then lay them out. The old
   * menu was six equal rows in no order — Resume next to Exit, Mute next to
   * Compete — so every visit meant re-reading the whole list. Grouping means you
   * navigate to a region, not to a line.
   *
   * Availability has THREE states, not two:
   *   enabled      normal
   *   unavailable  dimmed AND carrying the reason inline ("needs 2 players"),
   *                because a dimmed row with no explanation is a dead end
   *   hidden       omitted entirely — Requests when nobody is knocking, Leave
   *                when you are not in a session, Recenter when the runtime
   *                cannot offer it. No dead rows.
   */
  function buildModel() {
    const joined  = deps.isCoopJoined();
    const muted   = deps.isCoopMuted();
    const peers   = deps.getParticipantCount ? deps.getParticipantCount() : 0;
    const inMatch = deps.isMatchActive ? deps.isMatchActive() : false;
    const code    = deps.getOwnCode ? deps.getOwnCode() : null;

    if (view === 'skins') return buildSkinsModel();

    const out = [];

    // 1 ── HEADER: brand, the host code, and where you stand.
    out.push({ kind: 'header', code, status: statusLine(joined, peers, inMatch) });

    // 2 ── PLAY
    out.push({ kind: 'section', label: 'PLAY' });
    out.push({ kind: 'item', id: 'resume', label: 'RESUME', tone: 'primary' });

    // RECENTER is now a real one — xr.js re-origins the XR reference space so
    // "here, facing this way" becomes the world origin and forward. The row is
    // HIDDEN, not dimmed, when the runtime cannot offer an offset space: the
    // whole reason for replacing the old row is that it did nothing in VR, and
    // a dimmed replacement would be the same failure with better manners.
    if (!deps.canRecenter || deps.canRecenter()) {
      out.push({ kind: 'item', id: 'recenter', label: 'RECENTER VIEW', tone: 'primary' });
    }

    if (deps.listSkins) {
      const active = deps.getActiveSkinId ? deps.getActiveSkinId() : null;
      const name = (deps.listSkins().find((s) => s.id === active) || {}).name || '—';
      const gate = deps.canSwitchSkin ? deps.canSwitchSkin() : { ok: true };
      out.push({
        kind: 'submenu', id: 'skins', label: 'SKIN', meta: name, tone: 'primary',
        reason: gate.ok ? null : gate.reason,
      });
    }

    // RAPID FIRE. In a headset the DOM pay modal is invisible, so what is
    // surfaced here is the half that WORKS in-world: spending a banked charge.
    // Buying still needs the phone, and the row says so rather than opening a
    // QR nobody can see.
    const live    = deps.isRapidFire ? deps.isRapidFire() : false;
    const charges = deps.getAvailableCharges ? deps.getAvailableCharges() : 0;
    if (live) {
      const secs = deps.getRemainingSeconds ? Math.ceil(deps.getRemainingSeconds()) : 0;
      out.push({ kind: 'item', id: 'rapid', label: 'RAPID FIRE', meta: `${secs}s LEFT`,
                 tone: 'glow', state: 'unavailable', reason: 'already running' });
    } else if (charges > 0) {
      out.push({ kind: 'item', id: 'rapid', label: 'RAPID FIRE', meta: `${charges} READY`, tone: 'glow' });
    } else {
      out.push({ kind: 'item', id: 'rapid', label: 'RAPID FIRE', meta: '21 SATS', tone: 'glow',
                 state: 'unavailable', reason: 'pay on your phone — it upgrades both players' });
    }

    // 3 ── CO-OP
    out.push({ kind: 'section', label: 'CO-OP' });
    out.push({
      kind: 'toggle', id: 'mic', label: 'MIC', on: !muted, tone: 'primary',
      state: joined ? 'enabled' : 'unavailable',
      reason: joined ? null : 'join a session first',
    });
    out.push({
      kind: 'submenu', id: 'join', label: 'JOIN A FRIEND', tone: 'primary',
      state: 'unavailable', reason: 'share YOUR code above — they join from their phone',
    });
    out.push({
      kind: 'item', id: 'compete', label: 'COMPETE', meta: '4:20', tone: 'accent',
      state: deps.canCompete() ? 'enabled' : 'unavailable',
      reason: deps.canCompete() ? null
            : inMatch ? 'a match is already running' : 'needs 2 players',
    });
    // Requests only exist when somebody is knocking; there is no empty state.
    if (pending.length > 0) {
      out.push({ kind: 'request', id: 'request', name: pending[0].requesterName || 'Someone',
                 more: pending.length - 1 });
    }

    // 4 ── EXIT, separated. Danger lives HERE and nowhere else.
    out.push({ kind: 'rule' });
    if (joined) {
      const armed = performance.now() < confirmUntil;
      out.push({ kind: 'item', id: 'leave', tone: 'danger',
                 label: armed ? 'TAP AGAIN TO LEAVE' : 'LEAVE CO-OP',
                 meta: armed ? 'ARE YOU SURE?' : null, armed });
    }
    out.push({ kind: 'item', id: 'exit', label: 'EXIT TO SCREEN', tone: 'danger' });
    return out;
  }

  function buildSkinsModel() {
    const active = deps.getActiveSkinId ? deps.getActiveSkinId() : null;
    const gate   = deps.canSwitchSkin ? deps.canSwitchSkin() : { ok: true };
    const out = [
      { kind: 'header', code: deps.getOwnCode ? deps.getOwnCode() : null,
        status: statusLine(deps.isCoopJoined(), deps.getParticipantCount?.() || 0,
                           deps.isMatchActive?.() || false) },
      { kind: 'section', label: 'SKIN' },
    ];
    for (const skin of (deps.listSkins ? deps.listSkins() : [])) {
      const isActive = skin.id === active;
      const loading  = !!skin.isReady && !skin.isReady();
      out.push({
        kind: 'item', id: `skin:${skin.id}`, label: skin.name,
        meta: isActive ? 'ACTIVE' : loading ? 'LOADING…' : null,
        tone: isActive ? 'ok' : 'primary',
        state: isActive || loading || !gate.ok ? 'unavailable' : 'enabled',
        // The ACTIVE skin carries a reason too. Its "ACTIVE" badge already
        // implies why it is not tappable, but leaving reason null made it the
        // one non-enabled row in the whole menu that says nothing when you tap
        // it — an exception to the rule is how the rule gets forgotten.
        reason: isActive ? 'already active'
              : loading  ? 'still downloading'
              : gate.ok  ? null : gate.reason,
      });
    }
    out.push({ kind: 'rule' });
    out.push({ kind: 'item', id: 'back', label: '‹ BACK', tone: 'primary' });
    return out;
  }

  function statusLine(joined, peers, inMatch) {
    if (inMatch) return 'MATCH IN PROGRESS';
    if (!joined) return 'SOLO · WAITING FOR A FRIEND';
    const friends = Math.max(0, peers - 1);
    if (friends <= 0) return 'CONNECTED · WAITING FOR A FRIEND';
    return friends === 1 ? '1 FRIEND CONNECTED' : `${friends} FRIENDS CONNECTED`;
  }

  // ── Layout: assign a y and height to every entry ──────────────────────────
  // ONE pass produces the array that both draw() and idAt() consume, so a
  // highlighted row is always exactly the row that will fire. Nothing here is a
  // fixed index, which is what lets rows appear and disappear safely.
  function layout(model) {
    const laid = [];
    let y = PAD;
    for (const e of model) {
      let h;
      switch (e.kind) {
        case 'header':  h = 168; break;
        case 'section': h = LABEL_H + SECTION_GAP; break;
        case 'rule':    h = 20; break;
        case 'request': h = 84; break;
        default:        h = e.reason ? ROW_REASON : ROW_H; break;
      }
      laid.push({ ...e, y, h });
      y += h + (e.kind === 'section' || e.kind === 'rule' ? 0 : ROW_GAP);
    }
    // The footer hint owns the last ~30 px. If content ever runs past it, a row
    // is being drawn off the panel — which is how EXIT TO SCREEN disappeared the
    // first time this was built. Fail loudly in dev rather than silently clip.
    const limit = CANVAS_H - 34;
    if (import.meta.env.DEV && y > limit) {
      console.warn(`[vr-menu] layout overflows by ${Math.round(y - limit)}px ` +
                   `(${laid.length} entries) — the panel is too short for this state`);
    }
    return laid;
  }

  // ── Hit-testing: canvas point → row id ────────────────────────────────────
  // PlaneGeometry uv: u 0→1 left→right, v 0→1 bottom→top. CanvasTexture is
  // flipY by default, so canvas y = (1 - v) * CANVAS_H.
  function idAt(px, py) {
    for (const r of rows) {
      if (py < r.y || py >= r.y + r.h) continue;
      if (r.kind === 'request') {
        // Two targets on one row: approve left, deny right.
        return px < CANVAS_W / 2 ? 'approve' : 'deny';
      }
      if (r.kind === 'item' || r.kind === 'toggle' || r.kind === 'submenu') return r.id;
      return null; // header / section label / rule — inert by design
    }
    return null;
  }

  function pick(origin, direction) {
    raycaster.set(origin, direction);
    const hits = raycaster.intersectObject(panel, false);
    if (!hits.length || !hits[0].uv) return null;
    return idAt(hits[0].uv.x * CANVAS_W, (1 - hits[0].uv.y) * CANVAS_H);
  }

  // ── Open / close ───────────────────────────────────────────────────────────
  // UNCHANGED from P26: spawn from head YAW only at the head's world eye height,
  // then face the player level, and stay world-fixed.
  function placePanel() {
    const cam = renderer.xr.getCamera();
    cam.getWorldPosition(_camPos);
    cam.getWorldQuaternion(_camQuat);

    _fwd.set(0, 0, -1).applyQuaternion(_camQuat);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1); // looking straight up/down
    _fwd.normalize();

    // NOTE ON EYE HEIGHT: _camPos.y is the head's height in WORLD space, which
    // is true eye level under every reference space we request. eyeOffset is
    // deliberately NOT added — see the P26 note in git history.
    panel.position.set(
      _camPos.x + _fwd.x * DISTANCE,
      _camPos.y,
      _camPos.z + _fwd.z * DISTANCE,
    );
    panel.lookAt(_camPos.x, panel.position.y, _camPos.z);
  }

  function openMenu() {
    if (!renderer.xr.isPresenting) return; // headset VR/AR only
    placePanel();
    open = true;
    view = 'root';        // always open at the top level
    confirmUntil = 0;     // never re-open with LEAVE still armed
    panel.visible = true;
    hoverId = null;
    lastSig = null;
  }

  function closeMenu() {
    open = false;
    panel.visible = false;
    hoverId = null;
    confirmUntil = 0;
  }

  function toggleMenu() { if (open) closeMenu(); else openMenu(); }

  // A native headset exit (or Exit to screen) must never leave the menu latched
  // open — that would keep suppressing the trigger on the next session.
  renderer.xr.addEventListener('sessionend', closeMenu);

  function toast(msg) {
    toastSprite.setText(msg);
    toastUntil = performance.now() + TOAST_SECS * 1000;
  }

  // ── Selection — every branch calls EXISTING logic ──────────────────────────
  function activate(id) {
    const row = rows.find((r) => r.id === id);

    // Unavailable rows say WHY rather than doing nothing.
    if (row && row.state === 'unavailable' && id !== 'approve' && id !== 'deny') {
      if (row.reason) toast(row.reason);
      return;
    }

    if (id && id.startsWith('skin:')) {
      const skinId = id.slice(5);
      const res = deps.requestSkin ? deps.requestSkin(skinId) : { ok: false, reason: 'unavailable' };
      if (!res.ok) toast(res.reason || 'Cannot switch right now');
      else { view = 'root'; toast('Switching skin…'); }
      lastSig = null;
      return;
    }

    switch (id) {
      case 'resume':
        closeMenu();
        break;

      case 'recenter': {
        // Re-origin the XR space, then re-drop the panel so it is straight ahead
        // of the player's NEW forward rather than left behind at the old one.
        const done = deps.recenterXR ? deps.recenterXR() : false;
        if (done) { placePanel(); toast('View recentred'); }
        else toast('Recenter unavailable in this session');
        break;
      }

      case 'skins':
        view = 'skins';
        lastSig = null;
        break;

      case 'back':
        view = 'root';
        lastSig = null;
        break;

      case 'rapid':
        // The in-world half of the pay flow: spend a banked charge. Buying needs
        // the phone, and that row is marked unavailable-with-reason above, so we
        // only reach here when a charge exists.
        if (deps.activateCharge) deps.activateCharge();
        closeMenu();
        toast('Rapid fire activated');
        break;

      case 'mic':
        deps.coopToggleMute(); // coop-hud.js handleMute() — reads LiveKit truth
        lastSig = null;
        break;

      case 'compete':
        deps.proposeCompetition(); // competition.js propose()
        closeMenu();
        toast('Match proposed — waiting for opponent');
        break;

      case 'leave': {
        // Light confirm: a laser slip cannot dump a session. The first tap arms
        // the row (it relabels itself), the second within CONFIRM_MS commits.
        const now = performance.now();
        if (now >= confirmUntil) { confirmUntil = now + CONFIRM_MS; lastSig = null; break; }
        confirmUntil = 0;
        deps.coopLeave();
        closeMenu();
        toast('Left session');
        break;
      }

      case 'exit':
        closeMenu();          // close first so nothing is latched across session end
        deps.exitToScreen();  // modeswitcher.js exitToScreen()
        break;

      case 'approve': {
        const req = pending[0];
        if (!req) return;
        deps.approveJoinRequest(req.requestId);
        pending = pending.slice(1);   // optimistic; the poll re-syncs
        toast(`${req.requesterName || 'Player'} approved`);
        break;
      }

      case 'deny': {
        const req = pending[0];
        if (!req) return;
        deps.denyJoinRequest(req.requestId);
        pending = pending.slice(1);
        toast(`${req.requesterName || 'Player'} denied`);
        break;
      }

      default:
        break; // pointed at the panel but not at a row — swallow, don't fire
    }
  }

  // ── Trigger routing ────────────────────────────────────────────────────────
  // While the menu is open this returns true for EVERY tracked-controller
  // trigger — including one that misses the panel — so the gun cannot fire out
  // from under a menu the player is reading.
  function handleControllerSelect(origin, direction) {
    if (!open) return false;
    const id = pick(origin, direction);
    if (id) activate(id);
    return true;
  }

  // ── Per-frame update ───────────────────────────────────────────────────────
  function updateVrMenu() {
    const presenting = renderer.xr.isPresenting;

    if (!presenting) {
      if (open) closeMenu();
      noticeSprite.mesh.visible = false;
      toastSprite.mesh.visible  = false;
      return;
    }

    const cam = renderer.xr.getCamera();
    cam.getWorldPosition(_camPos);
    cam.getWorldQuaternion(_camQuat);

    if (open) {
      let hit = null;
      const controllers = deps.getControllers ? deps.getControllers() : [];
      for (const state of controllers) {
        if (!state.connected.value) continue;
        if (state.inputSource && state.inputSource.targetRayMode === 'screen') continue;
        _origin.setFromMatrixPosition(state.group.matrixWorld);
        _dir.set(0, 0, -1).transformDirection(state.group.matrixWorld).normalize();
        hit = pick(_origin, _dir);
        if (hit) break;
      }
      if (hit !== hoverId) hoverId = hit;
      repaintIfChanged();
    }

    const now = performance.now();
    const showNotice = now < noticeUntil;
    if (showNotice) {
      noticeSprite.mesh.visible = true;
    } else if (pending.length > 0 && !open) {
      noticeSprite.setText(`● ${pending.length} JOIN REQUEST${pending.length > 1 ? 'S' : ''}\npress X`);
      noticeSprite.mesh.visible = true;
    } else {
      noticeSprite.mesh.visible = false;
    }
    if (noticeSprite.mesh.visible) headLock(noticeSprite.mesh, NOTICE_OFFSET);

    toastSprite.mesh.visible = now < toastUntil;
    if (toastSprite.mesh.visible) headLock(toastSprite.mesh, TOAST_OFFSET);
  }

  function headLock(mesh, offset) {
    _offset.copy(offset).applyQuaternion(_camQuat);
    mesh.position.copy(_camPos).add(_offset);
    mesh.quaternion.copy(_camQuat);
  }

  // ── Repaint-on-change ──────────────────────────────────────────────────────
  function repaintIfChanged() {
    const top = pending[0];
    const sig = [
      view, hoverId,
      deps.isCoopMuted(), deps.isCoopJoined(), deps.canCompete(),
      deps.getParticipantCount ? deps.getParticipantCount() : 0,
      deps.isMatchActive ? deps.isMatchActive() : false,
      deps.getOwnCode ? deps.getOwnCode() : '',
      deps.getActiveSkinId ? deps.getActiveSkinId() : '',
      deps.isRapidFire ? deps.isRapidFire() : false,
      deps.isRapidFire && deps.isRapidFire() && deps.getRemainingSeconds
        ? Math.ceil(deps.getRemainingSeconds()) : 0,
      deps.getAvailableCharges ? deps.getAvailableCharges() : 0,
      pending.length, top ? top.requestId : '',
      performance.now() < confirmUntil,
    ].join('|');
    if (sig === lastSig) return;
    lastSig = sig;
    repaint();
  }

  // ── Paint ─────────────────────────────────────────────────────────────────
  function repaint() {
    rows = layout(buildModel());
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Panel body + glowing border (same treatment as the ACTIVATE panel).
    roundRect(ctx, 4, 4, CANVAS_W - 8, CANVAS_H - 8, 20);
    ctx.fillStyle = PANEL_BG();
    ctx.fill();
    ctx.strokeStyle = CYAN();
    ctx.lineWidth = 4;
    ctx.shadowColor = CYAN();
    ctx.shadowBlur = 22;
    ctx.stroke();
    ctx.shadowBlur = 0;

    for (const r of rows) {
      switch (r.kind) {
        case 'header':  drawHeader(r);  break;
        case 'section': drawSection(r); break;
        case 'rule':    drawRule(r);    break;
        case 'request': drawRequest(r); break;
        case 'toggle':  drawToggle(r);  break;
        case 'submenu': drawSubmenu(r); break;
        default:        drawItem(r);    break;
      }
    }

    // Footer hint — quiet, and smaller than every other string on the panel.
    ctx.font = `bold ${F_HINT}px monospace`;
    ctx.fillStyle = hexA(T.primary, 0.45);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('POINT + TRIGGER   ·   X TO CLOSE', CANVAS_W / 2, CANVAS_H - 26);

    tex.needsUpdate = true; // upload only on change
  }

  /**
   * The header does the single most important job on this panel: it makes
   * HOSTING require zero typing. The code is the largest thing here on purpose —
   * a headset player reads it out or a friend reads it off a shared screen, and
   * that is the whole join flow from this side.
   */
  function drawHeader(r) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.font = `bold ${F_BRAND}px monospace`;
    ctx.fillStyle = hexA(T.primary, 0.72);
    ctx.fillText('S A T S   A R E N A', CANVAS_W / 2, r.y + 14);

    const boxY = r.y + 28;
    const boxH = r.h - 28;   // 140 px of code block
    roundRect(ctx, PAD, boxY, CANVAS_W - PAD * 2, boxH, 14);
    ctx.fillStyle = hexA(T.glow, 0.07);
    ctx.fill();
    ctx.strokeStyle = hexA(T.glow, 0.30);
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = `bold ${F_LABEL}px monospace`;
    ctx.fillStyle = T.textMuted;
    ctx.fillText('YOUR CODE', CANVAS_W / 2, boxY + 18);

    // Until the session code arrives, say so. Showing placeholder dots under
    // "friends enter this to join" would be inviting the player to read out a
    // code that does not exist yet.
    const haveCode = !!r.code;
    ctx.font = `bold ${haveCode ? F_CODE : F_TITLE}px monospace`;
    ctx.fillStyle = haveCode ? T.glow : T.textMuted;
    if (haveCode) { ctx.shadowColor = T.glow; ctx.shadowBlur = 18; }
    ctx.fillText(haveCode ? r.code : 'GETTING CODE…', CANVAS_W / 2, boxY + 64);
    ctx.shadowBlur = 0;

    ctx.font = `${F_HINT}px monospace`;
    ctx.fillStyle = T.textMuted;
    ctx.fillText(haveCode ? 'friends enter this to join' : 'one moment', CANVAS_W / 2, boxY + 108);

    ctx.font = `bold ${F_LABEL}px monospace`;
    ctx.fillStyle = hexA(T.ok, 0.95);
    ctx.fillText(r.status, CANVAS_W / 2, boxY + 128);
  }

  function drawSection(r) {
    ctx.font = `bold ${F_LABEL}px monospace`;
    ctx.fillStyle = hexA(T.textMuted, 0.9);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const y = r.y + SECTION_GAP + LABEL_H / 2;
    ctx.fillText(spaced(r.label), PAD + 4, y);
    // A hairline that runs from the label to the panel edge ties the group
    // together without adding a box around it.
    const w = ctx.measureText(spaced(r.label)).width;
    ctx.strokeStyle = hexA(T.textMuted, 0.28);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD + 14 + w, y);
    ctx.lineTo(CANVAS_W - PAD, y);
    ctx.stroke();
  }

  function drawRule(r) {
    ctx.strokeStyle = hexA(T.danger, 0.28);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PAD, r.y + r.h / 2);
    ctx.lineTo(CANVAS_W - PAD, r.y + r.h / 2);
    ctx.stroke();
  }

  /** Colour by INTENT, resolved from the P51 tokens. Danger only in the footer. */
  function toneColour(tone) {
    switch (tone) {
      case 'accent': return T.accent;
      case 'danger': return T.danger;
      case 'glow':   return T.glow;
      case 'ok':     return T.ok;
      default:       return T.primary;
    }
  }

  function drawItem(r) {
    const unavailable = r.state === 'unavailable';
    const colour = unavailable ? T.textMuted : toneColour(r.tone);
    const hovered = hoverId === r.id;
    const rowH = r.h;
    const labelY = r.reason ? r.y + 26 : r.y + rowH / 2;

    drawRowChrome(r, colour, hovered, unavailable, rowH);

    ctx.font = `bold ${F_TITLE}px monospace`;
    ctx.fillStyle = colour;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    if (!unavailable) { ctx.shadowColor = colour; ctx.shadowBlur = hovered ? 16 : 8; }
    ctx.fillText(r.label, PAD + 22, labelY);
    ctx.shadowBlur = 0;

    if (r.meta) {
      ctx.font = `bold ${F_LABEL}px monospace`;
      ctx.fillStyle = unavailable ? hexA(T.textMuted, 0.85) : hexA(colour, 0.85);
      ctx.textAlign = 'right';
      ctx.fillText(r.meta, CANVAS_W - PAD - 22, labelY);
    }
    if (r.reason) drawReason(r);
  }

  // The reason is the row's SECOND LINE, inside its own height — not a floating
  // caption underneath it. That keeps a row one hit target and one visual unit,
  // and it is why rows with a reason are simply taller.
  function drawReason(r) {
    ctx.font = `${F_HINT}px monospace`;
    ctx.fillStyle = hexA(T.textMuted, 0.85);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(r.reason, PAD + 22, r.y + r.h - 18);
  }

  function drawSubmenuArrow(r, colour, labelY) {
    ctx.font = `bold ${F_TITLE}px monospace`;
    ctx.fillStyle = hexA(colour, 0.8);
    ctx.textAlign = 'right';
    ctx.fillText('›', CANVAS_W - PAD - 22, labelY - 2);
  }

  /** A submenu row is an item plus a chevron, and its meta sits inside the row. */
  function drawSubmenu(r) {
    const unavailable = r.state === 'unavailable';
    const colour = unavailable ? T.textMuted : toneColour(r.tone);
    const hovered = hoverId === r.id;
    const labelY = r.reason ? r.y + 26 : r.y + r.h / 2;
    drawRowChrome(r, colour, hovered, unavailable, r.h);

    ctx.font = `bold ${F_TITLE}px monospace`;
    ctx.fillStyle = colour;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    if (!unavailable) { ctx.shadowColor = colour; ctx.shadowBlur = hovered ? 16 : 8; }
    ctx.fillText(r.label, PAD + 22, labelY);
    ctx.shadowBlur = 0;

    if (r.meta) {
      ctx.font = `bold ${F_LABEL}px monospace`;
      ctx.fillStyle = hexA(colour, 0.85);
      ctx.textAlign = 'right';
      ctx.fillText(r.meta, CANVAS_W - PAD - 46, labelY);
    }
    drawSubmenuArrow(r, colour, labelY);
    if (r.reason) drawReason(r);
  }

  /**
   * A toggle is drawn as a SWITCH with a visible position, not as a label that
   * flips between "MUTE" and "UNMUTE". The old row made you read a verb and work
   * out whether it described the current state or the action — a switch shows
   * the state and the action at once. ON/OFF reflects LiveKit's real publish
   * state via isCoopMuted(), so it cannot lie the way a local boolean did.
   */
  function drawToggle(r) {
    const unavailable = r.state === 'unavailable';
    const colour = unavailable ? T.textMuted : (r.on ? T.ok : T.textMuted);
    const hovered = hoverId === r.id;
    const labelY = r.reason ? r.y + 26 : r.y + r.h / 2;
    drawRowChrome(r, unavailable ? T.textMuted : toneColour(r.tone), hovered, unavailable, r.h);

    ctx.font = `bold ${F_TITLE}px monospace`;
    ctx.fillStyle = unavailable ? T.textMuted : toneColour(r.tone);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(r.label, PAD + 22, labelY);

    // The switch itself.
    const sw = 86, sh = 34;
    const sx = CANVAS_W - PAD - 22 - sw;
    const sy = labelY - sh / 2;
    roundRect(ctx, sx, sy, sw, sh, sh / 2);
    ctx.fillStyle = r.on && !unavailable ? hexA(T.ok, 0.28) : hexA(T.textMuted, 0.18);
    ctx.fill();
    ctx.strokeStyle = hexA(colour, 0.8);
    ctx.lineWidth = 2;
    ctx.stroke();

    const knobR = sh / 2 - 6;
    const knobX = r.on ? sx + sw - knobR - 6 : sx + knobR + 6;
    ctx.beginPath();
    ctx.arc(knobX, sy + sh / 2, knobR, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    if (!unavailable) { ctx.shadowColor = colour; ctx.shadowBlur = 12; }
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.font = `bold ${F_HINT}px monospace`;
    ctx.fillStyle = hexA(colour, 0.95);
    ctx.textAlign = 'right';
    ctx.fillText(r.on ? 'ON' : 'OFF', sx - 12, labelY);

    if (r.reason) drawReason(r);
  }

  /** Approve / deny, only ever drawn when someone is actually knocking. */
  function drawRequest(r) {
    ctx.font = `bold ${F_LABEL}px monospace`;
    ctx.fillStyle = T.ok;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const label = `${trim(r.name, 18)} WANTS TO JOIN`
                + (r.more > 0 ? `  (+${r.more} MORE)` : '');
    ctx.fillText(label, PAD + 4, r.y + 14);

    const by = r.y + 30;
    const bh = r.h - 30;
    const half = (CANVAS_W - PAD * 2 - 12) / 2;
    drawPill('✓ APPROVE', T.ok,     PAD,               by, half, bh, hoverId === 'approve');
    drawPill('✗ DENY',    T.danger, PAD + half + 12,   by, half, bh, hoverId === 'deny');
  }

  function drawPill(label, colour, x, y, w, h, hovered) {
    roundRect(ctx, x, y, w, h, 10);
    ctx.fillStyle = hovered ? hexA(colour, 0.22) : hexA(colour, 0.08);
    ctx.fill();
    ctx.strokeStyle = hovered ? colour : hexA(colour, 0.45);
    ctx.lineWidth = 2;
    if (hovered) { ctx.shadowColor = colour; ctx.shadowBlur = 14; }
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.font = `bold ${F_TITLE - 4}px monospace`;
    ctx.fillStyle = colour;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + h / 2);
  }

  /** Hover fill/border, shared by every interactive row so they feel identical. */
  function drawRowChrome(r, colour, hovered, unavailable, h) {
    if (r.armed) {
      // An armed LEAVE is not merely hovered — it is waiting for a decision, and
      // it should look like it whether or not the laser is still on it.
      roundRect(ctx, PAD, r.y, CANVAS_W - PAD * 2, h, 12);
      ctx.fillStyle = hexA(T.danger, 0.22);
      ctx.fill();
      ctx.strokeStyle = T.danger;
      ctx.lineWidth = 3;
      ctx.stroke();
      return;
    }
    if (!hovered) return;
    roundRect(ctx, PAD, r.y, CANVAS_W - PAD * 2, h, 12);
    ctx.fillStyle = unavailable ? hexA(T.textMuted, 0.14) : hexA(colour, 0.18);
    ctx.fill();
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    ctx.shadowColor = colour;
    ctx.shadowBlur = 14;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function spaced(s) { return String(s).split('').join(' '); }

  // Paint an initial frame so the first open never shows an empty quad.
  repaint();

  // DEV: a headless check cannot join a session, receive a knock, or press a
  // controller trigger, so it needs to drive the same state those would produce.
  // Exposing the deps object and the view/pending fields lets it exercise the
  // REAL model and paint path rather than a mock of them.
  if (import.meta.env.DEV) {
    window.__vrMenuDev = {
      deps,
      setView:      (v)    => { view = v; lastSig = null; },
      pushRequests: (list) => { pending = list || []; lastSig = null; },
      setHover:     (id)   => { hoverId = id; lastSig = null; },
      forceRepaint: ()     => { lastSig = null; repaintIfChanged(); },
      rows:         ()     => rows.map(({ id, kind, label, meta, state, reason, y, h }) =>
                                ({ id, kind, label, meta, state, reason, y, h })),
      activate,
    };
  }

  return { updateVrMenu, handleControllerSelect, toggleMenu, isMenuOpen: () => open };
}

// ── Canvas helpers ───────────────────────────────────────────────────────────

// Hand-rolled rounded rect (rather than ctx.roundRect) so the panel draws
// identically on every browser the game targets.
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// '#rrggbb' + alpha → 'rgba(r,g,b,a)'.
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function trim(str, max) {
  const s = String(str);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
