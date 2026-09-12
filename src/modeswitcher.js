/**
 * modeswitcher.js — unified SCREEN / VR / AR mode selector.
 *
 * Split into two layers so a future in-world 3D switcher can reuse the logic:
 *
 *   createModeController(renderer)
 *     The brain. Owns capability detection and the actual mode switching as
 *     plain methods — enterVR(), enterAR(), exitToScreen() — plus a subscribe()
 *     for views to react to state changes. NO DOM knowledge. A future set of
 *     3D buttons inside the VR scene can call these same methods.
 *
 *   createDomSwitcher(controller, hudGrid)
 *     The view. Creates the three buttons, hands them to hud-grid.js to place
 *     and style, and wires them to the controller.
 *
 *   setupModeSwitcher(renderer)
 *     Composes both and returns the controller (so other code / a later 3D
 *     view can drive mode switching too).
 */

// WebXR session init options. AR requests dom-overlay so HTML (crosshair/HUD)
// shows over passthrough on handheld; Quest ignores what it doesn't use.
// local-floor / bounded-floor give a FLOOR-RELATIVE origin so the published head
// Y reflects real eye height above the floor (matching flat/mobile's assumed 1.6).
const VR_INIT = { optionalFeatures: ['local-floor', 'bounded-floor'] };
const AR_INIT = {
  optionalFeatures: ['dom-overlay', 'local-floor', 'bounded-floor'],
  domOverlay: { root: document.body },
};

// Fallback eye height (metres) added to a non-floor 'local' space so a VR/AR head
// is still published at a sensible standing height. Matches scene.js flat camera Y.
const ESTIMATED_EYE_HEIGHT = 1.6;

// ── Mode controller (no DOM) ────────────────────────────────────────────────

export function createModeController(renderer) {
  // capabilities: 'checking' | 'supported' | 'unsupported' (+ a reason string)
  const state = {
    activeMode: 'screen', // 'screen' | 'vr' | 'ar'
    vr: { status: 'checking', reason: '' },
    ar: { status: 'checking', reason: '' },
    // Eye-height offset added to the raw XR camera Y before publishing (metres).
    // 0 when a real floor-relative space (local-floor/bounded-floor) is granted;
    // ESTIMATED_EYE_HEIGHT when only a non-floor 'local' space is available.
    eyeOffset: 0,
  };

  const listeners = [];
  const notify = () => listeners.forEach((fn) => fn(state));

  /** Subscribe to state changes. Returns nothing; views re-render in the callback. */
  function subscribe(fn) {
    listeners.push(fn);
    fn(state); // push current state immediately
  }

  // ── Reference space selection (floor-relative eye height) ────────────────────
  // Pick the best floor-relative reference space the runtime actually granted,
  // set it on the renderer BEFORE setSession (Three reads referenceSpaceType when
  // it requests the space), and record the eye-height offset the publisher applies.
  //   local-floor / bounded-floor → floor at Y=0, head Y is real eye height  → offset 0
  //   local (no floor granted)     → origin at headset start, head Y ≈ 0      → offset 1.6
  // Only the Y ORIGIN differs between these; XZ behaviour is identical, so
  // locomotion/aim are unaffected.
  function applyReferenceSpace(session) {
    const feats = session.enabledFeatures;
    let type = 'local-floor'; // Quest default; safe when enabledFeatures is absent
    if (feats) {
      if      (feats.includes('local-floor'))   type = 'local-floor';
      else if (feats.includes('bounded-floor')) type = 'bounded-floor';
      else                                      type = 'local';
    }
    renderer.xr.setReferenceSpaceType(type);
    state.eyeOffset = (type === 'local') ? ESTIMATED_EYE_HEIGHT : 0;
    console.log(`[xr] reference space: ${type} (eyeOffset ${state.eyeOffset})`);
  }

  // ── Mode switching — the reusable methods (DOM + future 3D both call these) ──

  /**
   * A3: end whatever immersive session is running, and WAIT for it.
   *
   * Only one immersive session may exist at a time, so requesting immersive-ar
   * while immersive-vr was still live simply failed — AR<->VR did nothing and
   * you had to go out to SCREEN and back in. Awaiting the end is the point: the
   * request has to happen after the old session is actually gone, not merely
   * after we asked it to go.
   *
   * A failure here is deliberately swallowed rather than thrown. If the old
   * session refuses to end, the requestSession that follows will fail on its own
   * and be reported there; turning this into a hard error would leave the player
   * stuck in the session they are trying to leave.
   */
  async function endActiveSession() {
    const session = renderer.xr.getSession();
    if (!session) return;
    try {
      await session.end();
    } catch (err) {
      console.warn('[xr] could not end the running session cleanly:', err);
    }
  }

  // SEQUENCE, and it matters:
  //   1. await endActiveSession()   — the old session is gone, not just asked
  //   2. requestSession             — now permitted
  //   3. applyReferenceSpace        — SA4's floor-relative space, chosen from
  //                                   the NEW session's enabledFeatures
  //   4. setSession                 — hand it to three.js
  // Step 3 must sit between 2 and 4: it reads the granted features of the new
  // session, and the renderer needs the space type set before it takes over.
  //
  // Co-op note: ending the old session fires 'sessionend', so activeMode blips
  // to 'screen' for the frame or two before the new session starts. The pose
  // publisher has a branch for every mode and keeps publishing throughout — at
  // 15 Hz the blip costs at most one sample, published from the flat camera
  // instead of the XR camera, which peer interpolation absorbs. Publishing does
  // not stop and no listener is torn down.
  async function enterVR() {
    if (state.vr.status !== 'supported') return;
    try {
      await endActiveSession();
      const session = await navigator.xr.requestSession('immersive-vr', VR_INIT);
      applyReferenceSpace(session);        // set floor-relative space before setSession
      await renderer.xr.setSession(session);
      // activeMode is set by the sessionstart listener below.
    } catch (err) {
      console.warn('Failed to enter VR:', err);
    }
  }

  async function enterAR() {
    if (state.ar.status !== 'supported') return;
    try {
      await endActiveSession();
      const session = await navigator.xr.requestSession('immersive-ar', AR_INIT);
      applyReferenceSpace(session);        // set floor-relative space before setSession
      await renderer.xr.setSession(session);
    } catch (err) {
      console.warn('Failed to enter AR:', err);
    }
  }

  function exitToScreen() {
    // If an immersive session is running, end it — sessionend returns us to screen.
    const session = renderer.xr.getSession();
    if (session) session.end();
    // If already in screen mode, this is a no-op.
  }

  // ── Session lifecycle keeps activeMode honest ───────────────────────────────
  // Fires whether the session was started by us or ended by the headset's
  // native exit, so the active highlight is always correct.
  renderer.xr.addEventListener('sessionstart', () => {
    const session = renderer.xr.getSession();
    const blend = session && session.environmentBlendMode;
    state.activeMode = blend && blend !== 'opaque' ? 'ar' : 'vr';
    notify();
  });
  renderer.xr.addEventListener('sessionend', () => {
    state.activeMode = 'screen';
    notify();
  });

  // ── Async capability detection ──────────────────────────────────────────────
  // VR/AR start as 'checking' and flip once resolved — never the reverse, so
  // the buttons don't flicker from enabled to disabled.
  function detectCapabilities() {
    if (!navigator.xr || !navigator.xr.isSessionSupported) {
      state.vr = { status: 'unsupported', reason: 'WebXR unavailable' };
      state.ar = { status: 'unsupported', reason: 'WebXR unavailable' };
      notify();
      return;
    }

    navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
      state.vr = ok
        ? { status: 'supported', reason: '' }
        : { status: 'unsupported', reason: 'Not supported on this device' };
      notify();
    }).catch(() => {
      state.vr = { status: 'unsupported', reason: 'Not supported on this device' };
      notify();
    });

    navigator.xr.isSessionSupported('immersive-ar').then((ok) => {
      state.ar = ok
        ? { status: 'supported', reason: '' }
        : { status: 'unsupported', reason: 'Not supported on this device' };
      notify();
    }).catch(() => {
      state.ar = { status: 'unsupported', reason: 'Not supported on this device' };
      notify();
    });
  }

  detectCapabilities();

  return { state, subscribe, enterVR, enterAR, exitToScreen };
}

// ── DOM view ─────────────────────────────────────────────────────────────────

/**
 * The three mode buttons. They are CREATED here (this module owns what they do)
 * and PLACED by hud-grid.js, which owns the 2x3 cluster's geometry and look —
 * so there is exactly one description of a HUD button's size and treatment, and
 * it is not in this file.
 *
 * ── UNAVAILABLE IS DIMMED AND STILL TAPPABLE (P55) ──────────────────────────
 * The "WebXR unavailable on your device" caption used to live under every mode
 * button, permanently, in a second font size — three lines of apology occupying
 * the same row as the controls. It is now a tooltip you get by tapping, which
 * is the same information at the moment it is actually wanted, and the button
 * keeps `disabled` off so the tap can reach a handler at all: a `disabled`
 * button swallows clicks, which is precisely how "nothing happens when I press
 * it" became the unavailable state's whole experience.
 */
export function createDomSwitcher(controller, { adopt, showTooltip }) {
  const defs = [
    { mode: 'screen', cell: 'screen', label: 'SCREEN', action: controller.exitToScreen },
    { mode: 'vr',     cell: 'vr',     label: 'VR',     action: controller.enterVR },
    { mode: 'ar',     cell: 'ar',     label: 'AR',     action: controller.enterAR },
  ];

  const buttons = defs.map((def) => {
    const btn = document.createElement('button');
    btn.id = `mode-${def.mode}`;
    btn.type = 'button';
    btn.className = 'mode-btn';
    adopt(def.cell, btn, { label: def.label });

    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't let the click reach the canvas shoot handler
      btn.blur();          // drop focus so SPACE shoots instead of re-triggering this
      if (btn.classList.contains('checking')) return;
      if (btn.classList.contains('disabled')) {
        showTooltip(btn, btn.dataset.reason || 'Not available on your device');
        return;
      }
      def.action();
    });

    return { def, btn };
  });

  // Re-render button states whenever the controller's state changes.
  controller.subscribe((state) => {
    buttons.forEach(({ def, btn }) => {
      btn.classList.toggle('active', state.activeMode === def.mode);

      if (def.mode === 'screen') {
        // SCREEN is always available on every device.
        btn.classList.remove('checking', 'disabled');
        return;
      }

      const cap = state[def.mode]; // vr or ar
      btn.classList.toggle('checking', cap.status === 'checking');
      btn.classList.toggle('disabled', cap.status === 'unsupported');
      // The tooltip's text, carried on the element so the click handler needs no
      // closure over a value that changes.
      btn.dataset.reason = cap.status === 'unsupported'
        ? 'WebXR unavailable on your device' : '';
    });
  });
}

// ── Compose ──────────────────────────────────────────────────────────────────

export function setupModeSwitcher(renderer, hudGrid) {
  const controller = createModeController(renderer);
  createDomSwitcher(controller, hudGrid);
  return controller; // exposed so a future in-world 3D switcher can reuse it
}
