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
 *   - DeviceOrientation (gyroscope) → yaw + pitch, layered on top once granted.
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
// Tap (held straight) to re-level the view — fixes any mis-angled gyro calibration
// without a reload. Placed bottom-left, above the mode switcher.
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
    <div style="margin-top: 5px; font-size: 10px; letter-spacing: 0.06em; line-height: 1.3; color: #00e5ff; opacity: 0.75;">RECENTER<br>tilted? hold straight</div>`;
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
// Converts DeviceOrientationEvent alpha/beta/gamma into the device's RAW world
// quaternion (standard DeviceOrientationControls math, minus the screen term),
// anchors it to the hold at enable time, then applies the screen-orientation roll
// as a POST-rotation each frame:
//
//     camera = anchorInverse · deviceRaw_now · q0(screenOrient)
//
// Keeping the screen term OUTSIDE the anchor is the key fix: when it was baked
// into the anchor, rotating to landscape conjugated the result and swapped the
// pitch/yaw control axes (the landscape inversion). Composing quaternions also
// avoids gimbal lock, and a frame-rate-independent slerp smooths iOS jitter.
function setupGyro(camera) {
  const ZEE = new THREE.Vector3(0, 0, 1);
  const euler = new THREE.Euler();
  const q0 = new THREE.Quaternion();
  // -90° about X: the camera should look out the BACK of the phone, not the top.
  const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

  const deviceRaw     = new THREE.Quaternion();
  const anchorInverse = new THREE.Quaternion();
  const target        = new THREE.Quaternion();
  let haveAnchor = false;

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

  // Build the device's RAW orientation (no screen term) into `out`.
  function deviceRawQuaternion(out) {
    euler.set(beta, alpha, -gamma, 'YXZ');
    out.setFromEuler(euler);
    out.multiply(q1); // look out the back of the device
    return out;
  }

  window.addEventListener('deviceorientation', (e) => {
    if (e.alpha === null) return; // no usable sensor data
    alpha = THREE.MathUtils.degToRad(e.alpha);
    beta  = THREE.MathUtils.degToRad(e.beta);
    gamma = THREE.MathUtils.degToRad(e.gamma);

    if (!haveAnchor) {
      // Anchor the RAW hold (no screen term) — this becomes "looking forward".
      anchorInverse.copy(deviceRawQuaternion(deviceRaw)).invert();
      haveAnchor = true;
    }

    gyroActive = true; // gyro takes over; touch-drag look stands down
  });

  // "Recenter": drop the anchor so the next reading re-anchors at the current
  // pose — re-levels the view however the phone is held right now.
  gyroRecenter = () => { haveAnchor = false; };

  return (delta) => {
    if (!gyroActive || !haveAnchor) return;

    // target = anchorInverse · deviceRaw_now · q0(screenOrient)
    deviceRawQuaternion(deviceRaw);
    target.copy(anchorInverse).multiply(deviceRaw)
          .multiply(q0.setFromAxisAngle(ZEE, -screenOrient()));

    // Frame-rate-independent slerp toward the target (damps iOS jitter).
    const t = 1 - Math.pow(1 - SMOOTH, delta * 60);
    camera.quaternion.slerp(target, t);
  };
}
