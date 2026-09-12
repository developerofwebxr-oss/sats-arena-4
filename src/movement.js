import * as THREE from 'three';

/**
 * movement.js — camera rotation for desktop, mobile, and gyroscope.
 *
 * Desktop:
 *   - Mouse drag (click+drag) → yaw + pitch
 *   - Arrow keys → yaw + pitch (held, frame-rate independent)
 *
 * Mobile:
 *   - Touch-drag to look — always available, so the phone is playable even
 *     before / without motion permission.
 *   - DeviceOrientation (gyroscope) → the camera's full orientation, layered on
 *     top once granted. Pitch and roll come straight from gravity; only the
 *     HEADING is corrected, by a yaw about world up (P54).
 *   - iOS requires a permission button on first gesture; if denied or
 *     unavailable, touch-drag remains the look control.
 *
 * Quest:
 *   - No-op. WebXR head tracking overrides the camera automatically.
 *
 * Public API:
 *   setupMovement(camera, renderer) → { updateMovement(delta) }
 *   isDragging()                    → boolean — read by input.js to suppress shots during drag
 */

// ── Constants ──────────────────────────────────────────────────────────────────
const DRAG_THRESHOLD  = 4;       // pixels of movement before drag mode engages
const MOUSE_SPEED     = 0.003;   // radians per pixel (mouse)
const TOUCH_SPEED     = 0.004;   // radians per pixel (finger drag)
const KEY_SPEED       = 1.2;     // radians per second for arrow keys
const PITCH_MIN       = -0.7;    // radians — don't look too far down
const PITCH_MAX       = 0.7;     // radians — don't look too far up

// ── Shared camera state ────────────────────────────────────────────────────────
// We own yaw and pitch as plain numbers and write them to camera.rotation each frame.
// YXZ order = yaw around world Y first, then pitch around local X — standard FPS.
let yaw   = 0;
let pitch = -0.2; // matches the initial tilt that was in scene.js

// ── Drag flag (read by input.js) ───────────────────────────────────────────────
let _dragging = false;
export function isDragging() { return _dragging; }

// The same "recenter" action the mobile RECENTER button fires (see
// createRecenterButton below). Exported so the in-world VR/AR menu can invoke
// the identical logic instead of duplicating it. No-op until the gyro path has
// installed gyroRecenter (desktop/VR never do).
//
// P54 semantics: this makes the heading you are ALREADY looking at the neutral
// one. It does not move the view, and in particular it no longer swings you
// back to the load-time forward — see reanchor() for why that is exact.
export function recenterView() {
  if (gyroRecenter) gyroRecenter();
}

// True once the gyroscope is actively driving the view. While true, touch-drag
// look stands down so the two don't fight over yaw/pitch.
let gyroActive = false;

// Set by setupGyro — clears the gyro anchor so the next reading re-captures the
// current pose (the "recenter" action). Reuses the existing, tested anchor logic.
let gyroRecenter = null;

// ── Main setup ─────────────────────────────────────────────────────────────────
export function setupMovement(camera, renderer) {
  // YXZ rotation order is required for correct FPS-style camera behaviour.
  // With default 'XYZ', yaw and pitch interact and produce roll — feels wrong.
  camera.rotation.order = 'YXZ';
  camera.rotation.set(pitch, yaw, 0);

  const isMobile = 'ontouchstart' in window;

  // Update functions collected here; called each frame by updateMovement().
  const updaters = [];
  let recenterBtn = null; // mobile-only "⟲ RECENTER" button (created below)

  if (!isMobile) {
    // ── Desktop ───────────────────────────────────────────────────────────────
    updaters.push(setupMouseDrag(camera));
    updaters.push(setupArrowKeys(camera));
  } else {
    // ── Mobile ────────────────────────────────────────────────────────────────
    // Touch-drag look is always on (the reliable fallback). Gyro layers on top
    // when available/granted and takes over via the gyroActive flag.
    updaters.push(setupTouchLook(renderer));
    setupMobileGyro(updaters, renderer, camera);
    recenterBtn = createRecenterButton();
  }

  function updateMovement(delta) {
    // Skip all movement handling while inside a VR session —
    // the XR manager drives the camera pose directly.
    if (renderer.xr.isPresenting) {
      if (recenterBtn) recenterBtn.style.display = 'none'; // DOM not used in immersive
      return;
    }

    updaters.forEach(fn => fn(delta));

    // Show the recenter button only while the gyroscope is actually driving.
    if (recenterBtn) recenterBtn.style.display = gyroActive ? 'block' : 'none';

    // When the gyroscope is driving, it sets camera.quaternion directly (absolute
    // orientation) — don't overwrite it with the yaw/pitch euler below.
    if (gyroActive) return;

    // Clamp pitch and write final rotation to camera every frame (touch/mouse/keys).
    pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch));
    camera.rotation.set(pitch, yaw, 0);
  }

  return { updateMovement };
}

// ── Recenter button (mobile, gyro only) ─────────────────────────────────────────
// Tap to make your current heading the neutral one. It does not turn the view —
// there is nothing to hold straight for, because pitch and roll are read from
// gravity every frame (P54). Placed bottom-left, above the mode switcher.
function createRecenterButton() {
  const btn = document.createElement('button');
  btn.id = 'recenter-btn';
  // Round secondary button: smaller, dimmer cyan circle with a ⟲ icon, label below.
  // Block layout + text-align:center so the existing display:'block' toggle works.
  btn.innerHTML = `
    <div style="
      width: 56px; height: 56px; border-radius: 50%; margin: 0 auto;
      display: flex; align-items: center; justify-content: center;
      font-size: 34px; color: #00e5ff;
      background: rgba(0,229,255,0.07); border: 1px solid rgba(0,229,255,0.55);
      text-shadow: 0 0 8px rgba(0,229,255,0.7); box-shadow: 0 0 10px rgba(0,229,255,0.25);
    ">⟲</div>
    <div style="margin-top: 5px; font-size: 10px; letter-spacing: 0.06em; line-height: 1.3; color: #00e5ff; opacity: 0.75;">RECENTER<br>keeps your heading</div>`;
  btn.style.cssText = `
    display: none;
    position: fixed;
    bottom: 90px;
    left: 16px;
    width: 92px;
    text-align: center;
    background: transparent;
    border: none;
    padding: 0;
    font-family: monospace;
    cursor: pointer;
    z-index: 200;
  `;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();   // don't let the tap reach the canvas shoot handler
    if (gyroRecenter) gyroRecenter();
    btn.blur();
  });
  document.body.appendChild(btn);
  return btn;
}

// ── Mouse drag ─────────────────────────────────────────────────────────────────
function setupMouseDrag(camera) {
  let mouseDown  = false;
  let startX     = 0;
  let startY     = 0;
  let lastX      = 0;
  let lastY      = 0;

  window.addEventListener('mousedown', (e) => {
    // Only left button.
    if (e.button !== 0) return;
    mouseDown = true;
    _dragging = false;
    startX = lastX = e.clientX;
    startY = lastY = e.clientY;
  });

  window.addEventListener('mousemove', (e) => {
    if (!mouseDown) return;

    const totalDX = e.clientX - startX;
    const totalDY = e.clientY - startY;

    // Promote to drag once the threshold is exceeded.
    if (!_dragging && Math.sqrt(totalDX * totalDX + totalDY * totalDY) >= DRAG_THRESHOLD) {
      _dragging = true;
    }

    if (_dragging) {
      // Delta from last frame's mouse position, not from drag start,
      // so rotation feels continuous rather than snapping.
      yaw   -= (e.clientX - lastX) * MOUSE_SPEED;
      pitch -= (e.clientY - lastY) * MOUSE_SPEED;
    }

    lastX = e.clientX;
    lastY = e.clientY;
  });

  window.addEventListener('mouseup', () => {
    mouseDown = false;
    // Leave _dragging = true until the next frame so input.js's 'click'
    // handler (which fires after mouseup) can read it and skip the shot.
    // We reset it on the next mousedown instead.
  });

  // No per-frame work needed — all state is updated in event handlers above.
  return (_delta) => {};
}

// ── Arrow keys ─────────────────────────────────────────────────────────────────
function setupArrowKeys() {
  const keys = { ArrowLeft: false, ArrowRight: false, ArrowUp: false, ArrowDown: false };

  window.addEventListener('keydown', (e) => {
    if (e.code in keys) {
      keys[e.code] = true;
      e.preventDefault(); // stop the page from scrolling
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code in keys) keys[e.code] = false;
  });

  return (delta) => {
    if (keys.ArrowLeft)  yaw   += KEY_SPEED * delta;
    if (keys.ArrowRight) yaw   -= KEY_SPEED * delta;
    if (keys.ArrowUp)    pitch -= KEY_SPEED * delta;
    if (keys.ArrowDown)  pitch += KEY_SPEED * delta;
  };
}

// ── Touch-drag look (mobile, always available) ────────────────────────────────
// Drag a finger on the canvas to rotate the view — the reliable fallback that
// works with or without gyro. Stands down while gyroActive so they don't fight.
// Listeners are passive (no preventDefault) so they never suppress button taps.
function setupTouchLook(renderer) {
  let touchId = null;
  let startX = 0, startY = 0, lastX = 0, lastY = 0;

  window.addEventListener('touchstart', (e) => {
    if (renderer.xr.isPresenting || gyroActive) return;
    // Only look-drag on the game canvas — taps on UI buttons are left alone.
    if (e.target !== renderer.domElement) return;
    const t = e.changedTouches[0];
    touchId = t.identifier;
    _dragging = false;
    startX = lastX = t.clientX;
    startY = lastY = t.clientY;
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (touchId === null || gyroActive) return;
    for (const t of e.changedTouches) {
      if (t.identifier !== touchId) continue;

      // Promote to a drag once past the threshold (so a tap stays a tap = shot).
      const totalDX = t.clientX - startX;
      const totalDY = t.clientY - startY;
      if (!_dragging && Math.hypot(totalDX, totalDY) >= DRAG_THRESHOLD) {
        _dragging = true;
      }
      if (_dragging) {
        yaw   -= (t.clientX - lastX) * TOUCH_SPEED;
        pitch -= (t.clientY - lastY) * TOUCH_SPEED;
      }
      lastX = t.clientX;
      lastY = t.clientY;
    }
  }, { passive: true });

  window.addEventListener('touchend', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== touchId) continue;
      touchId = null;
      // Leave _dragging set until the next touchstart so input.js's touchend
      // (which runs in the same gesture) can read it and skip the shot.
    }
  });

  // All work happens in the event handlers; no per-frame update needed.
  return (_delta) => {};
}

// ── Mobile gyro setup ──────────────────────────────────────────────────────────
function setupMobileGyro(updaters, renderer, camera) {
  if (typeof DeviceOrientationEvent === 'undefined') return; // touch-drag is the fallback

  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    // iOS 13+ — must request permission from a user gesture (the button).
    showMotionButton(updaters, camera);
  } else {
    // Android and others — no permission needed; start gyro directly.
    updaters.push(setupGyro(camera));
  }
}

// ── iOS motion permission prompt ───────────────────────────────────────────────
// Centred prompt with a high z-index so nothing overlaps/steals the tap. Removed
// after the choice; if denied or it errors, touch-drag look remains in control.
function showMotionButton(updaters, camera) {
  const btn = document.createElement('button');
  btn.id = 'motion-btn';
  btn.textContent = '⚡ Enable Motion Controls';
  btn.style.cssText = `
    position: fixed;
    top: 42%;
    left: 50%;
    transform: translate(-50%, -50%);
    padding: 16px 26px;
    background: rgba(0,0,0,0.9);
    color: #f7931a;
    border: 1px solid #f7931a;
    font-family: monospace;
    font-size: 15px;
    letter-spacing: 0.08em;
    cursor: pointer;
    z-index: 300;
    text-shadow: 0 0 8px #f7931a;
    box-shadow: 0 0 24px rgba(247,147,26,0.3);
  `;

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const response = await DeviceOrientationEvent.requestPermission();
      btn.remove();
      if (response === 'granted') {
        updaters.push(setupGyro(camera));
      }
      // If denied, do nothing — touch-drag look is already active.
    } catch {
      btn.remove(); // touch-drag look remains
    }
  });

  document.body.appendChild(btn);
}

// ── Gyroscope (quaternion-based, robust) ───────────────────────────────────────
// Converts DeviceOrientationEvent alpha/beta/gamma into the device's full world
// quaternion (standard DeviceOrientationControls math, screen-orientation term
// included), then corrects ONLY its heading:
//
//     camera = Ry(yawOffset) · deviceQuaternion_now
//
// ── WHY THE CORRECTION IS A YAW AND NOT AN INVERSE (P54) ───────────────────────
// It used to be `anchorInverse · device_now`, where anchorInverse was the FULL
// inverse of whatever pose the phone happened to be in when the gyro started.
// A phone is never held upright, so that inverse carried the holding PITCH (and
// roll) as well as the heading — and a full-3DOF pre-rotation about an arbitrary
// axis is not a heading correction. It is exact at the anchor heading and wrong
// everywhere else, because the baked-in pitch no longer lines up with the pitch
// axis once you turn. Measured, holding the phone 15 deg back from upright and
// anchoring while facing forward:
//
//     heading      0      90      180      270
//     elevation    0    -14.48   -30.00   -14.48   deg   (spread 30.00)
//     roll         0    -15.50     0.00    15.50   deg   (spread 31.00)
//     horizon    406     256       71      256     px    (spread 335 on a 812px screen)
//
// Turn around and the horizon moves a third of a screen. Hold it 30 deg back and
// the errors double again (60 deg elevation spread). Pre-rotating about WORLD-UP
// instead leaves pitch and roll exactly as the device reports them — gravity
// referenced at every heading — and the same sweep measures 0.00 deg / 0.00 deg /
// 0 px of spread.
//
// The same numbers explain why this read as a per-skin bug: the math is shared,
// so the error is identical in every world. Classic simply has no horizon to
// measure it against — its floor/wall seam only exists at 2 of 4 headings (the
// skyline sits beyond the 30x30 radar floor, with void below the seam elsewhere),
// while Gold and Carnivorous are sealed rooms whose seam is continuous and sits
// within 0.3 deg of level at every heading. Same error, only two of the three
// worlds can show it. The arenas themselves are innocent: all three roots are at
// position 0,0,0 / rotation 0,0,0 / scale 1,1,1 with their floor at the rig's
// y=0 (Gold at -0.045, i.e. the 1.65 m eye its own notes specify).
//
// Keeping the screen term inside `deviceQuaternion` and OUTSIDE the yaw fix is
// what it always was: a post-multiplied roll about the view axis, which is why
// rotating to landscape no longer conjugates the result and swaps the control
// axes. Composing quaternions also avoids gimbal lock, and a frame-rate-
// independent slerp smooths iOS jitter.
function setupGyro(camera) {
  const ZEE      = new THREE.Vector3(0, 0, 1);
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  const euler = new THREE.Euler();
  const q0 = new THREE.Quaternion();
  // -90° about X: the camera should look out the BACK of the phone, not the top.
  const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

  const device  = new THREE.Quaternion();   // full device → world orientation
  const yawFix  = new THREE.Quaternion();   // pure rotation about world up
  const target  = new THREE.Quaternion();
  const tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');

  let yawOffset  = 0;       // radians about world up
  let haveOffset = false;   // set on the first reading, or by recenter
  let haveReading = false;  // a usable alpha/beta/gamma has arrived

  // Smoothing: fraction of the remaining gap closed per 60fps-equivalent frame.
  // High enough that Chrome stays crisp; enough to damp iOS sensor jitter.
  const SMOOTH = 0.5;

  // Latest reading in radians.
  let alpha = 0, beta = 0, gamma = 0;

  // Screen rotation (0/90/180/270) in radians — corrects portrait vs landscape.
  // screen.orientation is undefined on some iOS Safari versions; window.orientation
  // is the supported fallback there.
  function screenOrient() {
    const deg = (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0;
    return THREE.MathUtils.degToRad(deg);
  }

  /** The device's full orientation, screen term included, into `out`. */
  function deviceQuaternion(out) {
    euler.set(beta, alpha, -gamma, 'YXZ');
    out.setFromEuler(euler);
    out.multiply(q1);                                        // out the back of the device
    out.multiply(q0.setFromAxisAngle(ZEE, -screenOrient())); // portrait vs landscape
    return out;
  }

  /**
   * The rotation of `q` about world +Y — its heading, with pitch and roll left
   * out. This is the ONE quantity a heading correction may touch.
   *
   * It is the twist half of a swing/twist split, and it is exact rather than
   * approximate: pre-multiplying by a rotation of t about world up maps
   * (w + i·y) → e^{it/2}·(w + i·y), so this returns t more than it did before.
   * Verified to 1e-13 deg over 20k random quaternions. Unlike reading the yaw
   * off the forward vector it does not degenerate when you look straight up.
   */
  function yawAboutUp(q) { return 2 * Math.atan2(q.y, q.w); }

  /** target = Ry(yawOffset) · device, into `target`. */
  function buildTarget() {
    deviceQuaternion(device);
    yawFix.setFromAxisAngle(WORLD_UP, yawOffset);
    return target.copy(yawFix).multiply(device);
  }

  /**
   * Make the heading currently on screen the new neutral, WITHOUT moving the
   * view. That is not a figure of speech: with the correction constrained to
   * world-up, the shown heading is exactly `yawOffset + yawAboutUp(device)`, so
   * solving for the offset that reproduces it returns the offset we already
   * had. Recentering cannot swing the player round, by construction — which is
   * the whole requirement. What it still does is real:
   *
   *   · establishes the neutral the FIRST time, from the heading the player was
   *     already looking at with drag-look, so switching the gyro on is silent;
   *   · re-derives the offset as a pure world-up yaw, repairing any state left
   *     over from a stale or contaminated anchor;
   *   · drops the smoothing lag, so "does not move" is literal, not approximate.
   *
   * Pitch and roll need no re-levelling here because they are never corrected
   * at all — they come straight from gravity on every frame.
   */
  function reanchor() {
    if (!haveReading) { haveOffset = false; return; } // the next reading will set it
    const heading = yawAboutUp(deviceQuaternion(device));
    // Degenerate only for an exact 180° flip about a horizontal axis, where the
    // heading is genuinely undefined. Keep what we have rather than guess.
    if (Math.abs(device.y) < 1e-6 && Math.abs(device.w) < 1e-6) return;
    // Before the first anchor the player's heading is the drag-look yaw.
    const shown = haveOffset ? yawOffset + heading : yaw;
    yawOffset  = shown - heading;
    haveOffset = true;
    camera.quaternion.copy(buildTarget());
    syncLookState();
  }

  /**
   * Keep the drag-look yaw/pitch in step with where the gyro is actually
   * pointing. Nothing reads them while the gyro drives, but they are what the
   * camera falls back to the moment it stops — so without this, turning motion
   * off would snap the view back to wherever the last finger drag left it.
   */
  function syncLookState() {
    tmpEuler.setFromQuaternion(camera.quaternion, 'YXZ');
    yaw   = tmpEuler.y;
    pitch = tmpEuler.x;   // roll is dropped: drag-look has no roll to restore
  }

  window.addEventListener('deviceorientation', (e) => {
    if (e.alpha === null) return; // no usable sensor data
    alpha = THREE.MathUtils.degToRad(e.alpha);
    beta  = THREE.MathUtils.degToRad(e.beta);
    gamma = THREE.MathUtils.degToRad(e.gamma);
    haveReading = true;

    // First usable reading: adopt the heading the player already had, so the
    // world does not swing the instant motion controls come alive.
    if (!haveOffset) reanchor();

    gyroActive = true; // gyro takes over; touch-drag look stands down
  });

  // The mobile RECENTER control and the in-world menu both land here.
  gyroRecenter = reanchor;

  return (delta) => {
    if (!gyroActive || !haveOffset) return;

    buildTarget();

    // Frame-rate-independent slerp toward the target (damps iOS jitter).
    const t = 1 - Math.pow(1 - SMOOTH, delta * 60);
    camera.quaternion.slerp(target, t);
    syncLookState();
  };
}
