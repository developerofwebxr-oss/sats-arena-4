import * as THREE from 'three';
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
const CYAN    = '#00e5ff'; // primary UI (SHOOT button, radar, session chip)
const MAGENTA = '#b14bff'; // competition + rapid-fire (matches #cmp-compete)
const ORANGE  = '#f7931a'; // bitcoin accent (score, laser)
const GREEN   = '#4dff9e'; // competition "win" green → approve
const RED     = '#ff5d6c'; // competition "lose" red → deny / destructive
const DIM     = '#5a6b7d'; // unavailable
const PANEL_BG = 'rgba(8,8,14,0.92)'; // identical to the ACTIVATE panel

// ── Panel geometry ───────────────────────────────────────────────────────────
// 640×768 texture on a 0.85×1.02 m quad at 1.5 m ≈ 1 texel per display pixel on
// a Quest 2 (~20 px/°), so labels stay crisp without wasting memory.
const CANVAS_W = 640;
const CANVAS_H = 768;
const PANEL_W  = 0.85;                              // metres
const PANEL_H  = PANEL_W * (CANVAS_H / CANVAS_W);   // 1.02 m
const DISTANCE = 1.5;                               // metres ahead of the head

// ── Row layout (canvas px, y from top). Drawing and hit-testing both read
// these, so a highlighted row is always exactly the row you select. ───────────
const TITLE_H   = 84;
const ROW_TOP   = 96;
const ROW_H     = 78;
const ROW_PITCH = 88;   // ROW_H + 10 px gap
const ROW_COUNT = 6;    // last row ends at 614
const KNOCK_TOP = 624;
const KNOCK_H   = 88;   // ends at 712
const HINT_Y    = 736;  // clear of the 762 px border

// ── Head-locked sprite offsets (metres from the head; -Z forward). Tunable
// on-device, same convention as vrui.js. ─────────────────────────────────────
const NOTICE_OFFSET = new THREE.Vector3(0,  0.88, -2.0); // knock notice / badge
const TOAST_OFFSET  = new THREE.Vector3(0,  0.02, -2.0); // gentle action toasts
const NOTICE_SECS   = 6.0;
const TOAST_SECS    = 2.8;

/**
 * @param scene     THREE.Scene
 * @param renderer  THREE.WebGLRenderer (XR-enabled)
 * @param deps      the EXISTING actions this menu drives:
 *   recenterView, coopLeave, coopToggleMute, isCoopMuted, isCoopJoined,
 *   canCompete, proposeCompetition, exitToScreen, onPendingRequests,
 *   approveJoinRequest, denyJoinRequest, getControllers
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
  panel.visible = false;
  panel.renderOrder = 10; // draw after the world so it reads clearly in AR
  scene.add(panel);

  // ── Head-locked text sprites (same helper as the rest of the in-world HUD) ──
  const noticeSprite = createTextSprite(1.3, CYAN);   // "X wants to join — press X"
  const toastSprite  = createTextSprite(1.0, ORANGE); // gentle feedback
  noticeSprite.mesh.visible = false;
  toastSprite.mesh.visible  = false;
  scene.add(noticeSprite.mesh, toastSprite.mesh);

  // ── State ──────────────────────────────────────────────────────────────────
  let open      = false;
  let hoverId   = null;   // row id currently under a controller laser
  let lastSig   = null;   // repaint-on-change guard
  let pending   = [];     // mirrored pending join requests (from coop-hud.js)
  let seenReqId = null;   // last request id we announced, so we notify once
  let noticeUntil = 0;
  let toastUntil  = 0;

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
      // A NEW knock arrived: announce it once, in-world.
      seenReqId = top.requestId;
      noticeSprite.setText(`${top.requesterName || 'Someone'} wants to join\npress X to open the menu`);
      noticeUntil = performance.now() + NOTICE_SECS * 1000;
    }
    if (!top) seenReqId = null;
  });

  // ── Items ──────────────────────────────────────────────────────────────────
  // Row order is FIXED so it stays predictable in a headset; unavailable items
  // are dimmed (and explain themselves on tap) rather than disappearing.
  function currentItems() {
    const joined = deps.isCoopJoined();
    const muted  = deps.isCoopMuted();
    return [
      { id: 'resume',   label: 'RESUME',                          color: CYAN },
      { id: 'recenter', label: 'RECENTER VIEW',                   color: CYAN },
      { id: 'mute',     label: muted ? 'UNMUTE MIC' : 'MUTE MIC', color: muted ? ORANGE : CYAN, dim: !joined },
      { id: 'compete',  label: 'COMPETE · 4:20',                  color: MAGENTA, dim: !deps.canCompete() },
      { id: 'leave',    label: 'LEAVE CO-OP',                     color: RED,     dim: !joined },
      { id: 'exit',     label: 'EXIT TO SCREEN',                  color: RED },
    ];
  }

  // ── Hit-testing: map a hit UV on the single quad to a row id ───────────────
  // PlaneGeometry uv: u 0→1 left→right, v 0→1 bottom→top. CanvasTexture is
  // flipY by default, so canvas y = (1 - v) * CANVAS_H.
  function idAt(px, py) {
    if (py >= ROW_TOP && py < ROW_TOP + ROW_COUNT * ROW_PITCH) {
      const i = Math.floor((py - ROW_TOP) / ROW_PITCH);
      // Reject the inter-row gap so the laser can't select a row it isn't on.
      if ((py - ROW_TOP) - i * ROW_PITCH > ROW_H) return null;
      const items = currentItems();
      return items[i] ? items[i].id : null;
    }
    // Knock row: only interactive while a request is actually pending.
    if (pending.length > 0 && py >= KNOCK_TOP + 30 && py < KNOCK_TOP + KNOCK_H) {
      return px < CANVAS_W / 2 ? 'approve' : 'deny';
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
  // Spawn from head YAW only at the head's world eye height, then face the
  // player level — so the panel sits straight ahead at eye level however the
  // head was pitched or rolled when X was pressed.
  function placePanel() {
    const cam = renderer.xr.getCamera();
    cam.getWorldPosition(_camPos);
    cam.getWorldQuaternion(_camQuat);

    // Forward flattened onto the horizontal plane = pure yaw.
    _fwd.set(0, 0, -1).applyQuaternion(_camQuat);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1); // looking straight up/down
    _fwd.normalize();

    // NOTE ON EYE HEIGHT: _camPos.y is the head's height in WORLD space, which
    // is true eye level under every reference space we request — with
    // local-floor/bounded-floor the floor is Y=0 so this is the real eye
    // height, and with the 'local' fallback the origin IS the head so this is
    // still eye level. modeCtrl.state.eyeOffset is deliberately NOT added: that
    // offset is a publish-time convention for telling peers a floor-relative
    // eyeY (see pose-publisher.js), and adding it here would push the panel
    // 1.6 m above the player's eyes in the 'local' fallback.
    panel.position.set(
      _camPos.x + _fwd.x * DISTANCE,
      _camPos.y,
      _camPos.z + _fwd.z * DISTANCE,
    );
    // Face the head, level: look at the head's position at the panel's own
    // height, so there's no pitch in the panel itself.
    panel.lookAt(_camPos.x, panel.position.y, _camPos.z);
  }

  function openMenu() {
    if (!renderer.xr.isPresenting) return; // headset VR/AR only
    placePanel();
    open = true;
    panel.visible = true;
    hoverId = null;
    lastSig = null; // force a repaint on the frame we open
  }

  function closeMenu() {
    open = false;
    panel.visible = false;
    hoverId = null;
  }

  function toggleMenu() {
    if (open) closeMenu(); else openMenu();
  }

  // A native headset exit (or Exit to screen) must never leave the menu latched
  // open — that would keep suppressing the trigger on the next session.
  renderer.xr.addEventListener('sessionend', closeMenu);

  function toast(msg) {
    toastSprite.setText(msg);
    toastUntil = performance.now() + TOAST_SECS * 1000;
  }

  // ── Selection — every branch calls EXISTING logic ──────────────────────────
  function activate(id) {
    const items = currentItems();
    const item  = items.find((it) => it.id === id);

    // Dimmed rows explain themselves instead of doing nothing.
    if (item && item.dim) {
      if (id === 'compete') toast('Need a second player to compete');
      else                  toast('Not connected to a session');
      return;
    }

    switch (id) {
      case 'resume':
        closeMenu();
        break;

      case 'recenter':
        deps.recenterView(); // movement.js — the same action as the DOM RECENTER button
        placePanel();        // and re-drop the panel straight ahead of the player
        break;

      case 'mute':
        deps.coopToggleMute(); // coop-hud.js handleMute() — same as the DOM MUTE button
        break;

      case 'compete':
        deps.proposeCompetition(); // competition.js propose() — same as #cmp-compete
        closeMenu();
        toast('Match proposed — waiting for opponent');
        break;

      case 'leave':
        deps.coopLeave();      // coop-hud.js handleLeave() — same as the DOM LEAVE button
        closeMenu();
        toast('Left session');
        break;

      case 'exit':
        closeMenu();           // close first so nothing is latched across the session end
        deps.exitToScreen();   // modeswitcher.js exitToScreen()
        break;

      case 'approve': {
        const req = pending[0];
        if (!req) return;
        deps.approveJoinRequest(req.requestId); // coop-hud.js _approveRequest()
        pending = pending.slice(1);             // optimistic; the poll re-syncs
        toast(`${req.requesterName || 'Player'} approved`);
        break;
      }

      case 'deny': {
        const req = pending[0];
        if (!req) return;
        deps.denyJoinRequest(req.requestId);    // coop-hud.js _denyRequest()
        pending = pending.slice(1);
        toast(`${req.requesterName || 'Player'} denied`);
        break;
      }

      default:
        break; // pointed at the panel but not at a row — swallow, don't fire
    }
  }

  // ── Trigger routing ────────────────────────────────────────────────────────
  // Called from xr.js's tracked-controller selectstart, BEFORE the ACTIVATE
  // panel handler and before the shot. Returning true consumes the trigger.
  //
  // While the menu is open this returns true for EVERY tracked-controller
  // trigger — including one that misses the panel — so the gun cannot fire out
  // from under a menu the player is reading. The moment the menu closes it
  // returns false again on the first line, so firing is restored with no
  // residual state to unwind.
  function handleControllerSelect(origin, direction) {
    if (!open) return false;
    const id = pick(origin, direction);
    if (id) activate(id);
    return true; // menu open ⇒ trigger belongs to the menu, never to the gun
  }

  // ── Per-frame update ───────────────────────────────────────────────────────
  function updateVrMenu() {
    const presenting = renderer.xr.isPresenting;

    if (!presenting) {
      // Flat/mobile keep the DOM UI; hide every in-world element.
      if (open) closeMenu();
      noticeSprite.mesh.visible = false;
      toastSprite.mesh.visible  = false;
      return;
    }

    const cam = renderer.xr.getCamera();
    cam.getWorldPosition(_camPos);
    cam.getWorldQuaternion(_camQuat);

    // Hover: raycast from each connected tracked controller.
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

    // Knock notice, then the persistent badge chip while the menu is closed.
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
      hoverId,
      deps.isCoopMuted(),
      deps.isCoopJoined(),
      deps.canCompete(),
      pending.length,
      top ? top.requestId : '',
    ].join('|');
    if (sig === lastSig) return;
    lastSig = sig;
    repaint();
  }

  function repaint() {
    const items = currentItems();
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Panel body + glowing border (same treatment as the ACTIVATE panel).
    roundRect(ctx, 4, 4, CANVAS_W - 8, CANVAS_H - 8, 18);
    ctx.fillStyle = PANEL_BG;
    ctx.fill();
    ctx.strokeStyle = CYAN;
    ctx.lineWidth = 4;
    ctx.shadowColor = CYAN;
    ctx.shadowBlur = 22;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Title, with a badge when someone is knocking.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 38px monospace';
    ctx.fillStyle = CYAN;
    ctx.shadowColor = CYAN;
    ctx.shadowBlur = 14;
    ctx.fillText('MENU', CANVAS_W / 2, TITLE_H / 2 + 3);
    ctx.shadowBlur = 0;

    if (pending.length > 0) {
      ctx.beginPath();
      ctx.arc(CANVAS_W - 46, TITLE_H / 2 + 3, 13, 0, Math.PI * 2);
      ctx.fillStyle = GREEN;
      ctx.shadowColor = GREEN;
      ctx.shadowBlur = 16;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#04060a';
      ctx.font = 'bold 17px monospace';
      ctx.fillText(String(pending.length), CANVAS_W - 46, TITLE_H / 2 + 4);
    }

    // Divider under the title.
    ctx.strokeStyle = 'rgba(0,229,255,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(24, TITLE_H);
    ctx.lineTo(CANVAS_W - 24, TITLE_H);
    ctx.stroke();

    // Rows.
    items.forEach((item, i) => {
      const y = ROW_TOP + i * ROW_PITCH;
      drawRow(item.label, item.dim ? DIM : item.color, 20, y, CANVAS_W - 40, ROW_H,
              hoverId === item.id, item.dim);
    });

    // Divider above the knock zone — groups actions vs. join requests.
    ctx.strokeStyle = 'rgba(0,229,255,0.18)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(24, KNOCK_TOP - 12);
    ctx.lineTo(CANVAS_W - 24, KNOCK_TOP - 12);
    ctx.stroke();

    // Knock row.
    const top = pending[0];
    if (top) {
      ctx.font = 'bold 26px monospace';
      ctx.fillStyle = GREEN;
      ctx.textAlign = 'center';
      ctx.fillText(`${trim(top.requesterName || 'Someone', 22)} WANTS TO JOIN`,
                   CANVAS_W / 2, KNOCK_TOP + 15);
      const by = KNOCK_TOP + 32;
      const bh = KNOCK_H - 32;
      // These two carry a faint resting outline (the action rows don't) so the
      // player can see there are two separate laser targets before hovering.
      drawRow('✓ APPROVE', GREEN, 20, by, CANVAS_W / 2 - 28, bh, hoverId === 'approve', false, 26, true);
      drawRow('✗ DENY',    RED,   CANVAS_W / 2 + 8, by, CANVAS_W / 2 - 28, bh, hoverId === 'deny', false, 26, true);
    } else {
      ctx.font = 'bold 24px monospace';
      ctx.fillStyle = DIM;
      ctx.textAlign = 'center';
      ctx.fillText('NO PENDING REQUESTS', CANVAS_W / 2, KNOCK_TOP + KNOCK_H / 2);
    }

    // Footer hint.
    ctx.font = 'bold 19px monospace';
    ctx.fillStyle = 'rgba(0,229,255,0.45)';
    ctx.textAlign = 'center';
    ctx.fillText('POINT + TRIGGER   ·   X TO CLOSE', CANVAS_W / 2, HINT_Y);

    tex.needsUpdate = true; // upload only on change
  }

  // One menu row: hover fill/border matches the DOM SHOOT button treatment
  // (rgba(0,229,255,.18) on a 2px cyan border) so in-world and DOM feel alike.
  function drawRow(label, color, x, y, w, h, hovered, dim, fontPx = 34, outline = false) {
    if (outline && !hovered) {
      roundRect(ctx, x, y, w, h, 10);
      ctx.strokeStyle = hexA(color, 0.35);
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (hovered) {
      roundRect(ctx, x, y, w, h, 10);
      ctx.fillStyle = dim ? 'rgba(90,107,125,0.16)' : hexA(color, 0.18);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ctx.font = `bold ${fontPx}px monospace`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (!dim) { ctx.shadowColor = color; ctx.shadowBlur = hovered ? 16 : 8; }
    ctx.fillText(label, x + w / 2, y + h / 2);
    ctx.shadowBlur = 0;
  }

  // Paint an initial frame so the first open never shows an empty quad.
  repaint();

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
