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
 *   - DeviceOrientation (gyroscope) → yaw + pitch, layered on top while the
 *     HUD's GYRO toggle is on. No auto-start, no standalone prompt (P55).
 *   - iOS requires permission from a user gesture; the GYRO tap IS that gesture.
 *     If denied or unavailable, touch-drag remains the look control.
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

// The same "recenter" action the HUD's RECENTER popup fires (hud-grid.js, via
// the gyro controller). Exported so the in-world VR/AR menu can invoke the
// identical logic instead of duplicating it. No-op until the gyro path has
// installed gyroRecenter (desktop/VR never do).
export function recenterView() {
  if (gyroRecenter) gyroRecenter();
}

// True once the gyroscope is actively driving the view. While true, touch-drag
// look stands down so the two don't fight over yaw/pitch.
let gyroActive = false;

// The player's switch (P55). `gyroActive` says the sensor is currently steering;
// this says they asked for it at all. Two flags rather than one because a reading
// can arrive after the toggle went off, and that reading must not resurrect it.
let gyroEnabled = false;

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
  let gyro = null;   // the controller the HUD's GYRO toggle drives; null on desktop

  if (!isMobile) {
    // ── Desktop ───────────────────────────────────────────────────────────────
    updaters.push(setupMouseDrag(camera));
    updaters.push(setupArrowKeys(camera));
  } else {
    // ── Mobile ────────────────────────────────────────────────────────────────
    // Touch-drag look is always on (the reliable fallback). Gyro layers on top
    // when the player turns it on and takes over via the gyroActive flag.
    updaters.push(setupTouchLook(renderer));
    gyro = createGyroController(updaters, camera);
  }

  function updateMovement(delta) {
    // Skip all movement handling while inside a VR session —
    // the XR manager drives the camera pose directly.
    if (renderer.xr.isPresenting) return;

    updaters.forEach(fn => fn(delta));

    // When the gyroscope is driving, it sets camera.quaternion directly (absolute
    // orientation) — don't overwrite it with the yaw/pitch euler below.
    if (gyroActive) return;

    // Clamp pitch and write final rotation to camera every frame (touch/mouse/keys).
    pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch));
    camera.rotation.set(pitch, yaw, 0);
  }

  return { updateMovement, gyro };
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

// ── The gyro controller (P55) ────────────────────────────────────────────────
// Motion look is no longer something the page turns on by itself. There is one
// switch — the HUD's GYRO button — and this is what it drives. The old surface
// was two pieces of furniture in the middle of the screen: a full-width "Enable
// Motion Controls" prompt on iOS, and a RECENTER circle that appeared only once
// the gyro happened to be live. Both are gone; the toggle and its popup replace
// them, and this object is the whole seam between them and the sensor.
//
// ENABLE IS ASYNC BECAUSE iOS MAKES IT ASYNC. requestPermission() must be called
// from inside a user gesture, so it is awaited in the toggle's click handler and
// the result is what the button renders — never a guess, and never a prompt the
// player did not ask for.
//
// The updater is installed ONCE, on the first successful enable, and afterwards
// `gyroEnabled` gates it. Re-installing per enable would stack a second
// deviceorientation listener and a second slerp writing the same camera.
//
// ── ONLY A TAP MAY ASK (P57) ────────────────────────────────────────────────
// enable() takes `prompt`, and everything automatic must pass false. See the
// note on enable(): a gesture-less requestPermission() on iOS is not a harmless
// failure, it burns the page's one opportunity to show the dialog at all.
function createGyroController(updaters, camera) {
  const available = typeof DeviceOrientationEvent !== 'undefined';
  let installed = false;

  /**
   * The permission gate, or null where there is none.
   *
   * iOS puts it on DeviceOrientationEvent; the DeviceMotionEvent one is the same
   * "Motion & Orientation Access" grant, so it is only a fallback for a browser
   * that somehow ships one and not the other. Asking through both would risk two
   * dialogs for one permission.
   */
  function permissionGate() {
    if (!available) return null;
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      return () => DeviceOrientationEvent.requestPermission();
    }
    if (typeof DeviceMotionEvent !== 'undefined'
        && typeof DeviceMotionEvent.requestPermission === 'function') {
      return () => DeviceMotionEvent.requestPermission();
    }
    return null;   // Android and desktop Chrome: nothing to ask for
  }

  function install() {
    if (!installed) { updaters.push(setupGyro(camera)); installed = true; }
    gyroEnabled = true;
    return true;
  }

  return {
    isAvailable:     () => available,
    isOn:            () => gyroEnabled,
    needsPermission: () => permissionGate() !== null,

    /**
     * Turn motion look on.
     *
     * `prompt` is not a convenience — it is the whole P57 fix. Calling
     * requestPermission() outside a user gesture does not merely fail on iOS: it
     * SPENDS THE PAGE'S ONE CHANCE. Safari will not raise the dialog again for
     * that page load once the page has asked without a gesture, so the tap that
     * follows is refused before the user ever sees a prompt — and because the
     * refusal is remembered, every later tap is refused too. Measured: a session
     * restore firing one gesture-less request left the toggle dead at one, two
     * and three subsequent taps, with the deviceorientation listener never
     * attached.
     *
     * So: only a real tap may pass `prompt: true`. Anything automatic passes
     * false and simply declines to resume on a platform that would need to ask.
     *
     * @param {{prompt?: boolean}} [opts]
     * @returns {Promise<boolean>} true once motion look is actually live.
     */
    async enable({ prompt = true } = {}) {
      if (!available) return false;
      const ask = permissionGate();
      if (!ask) return install();          // nothing to ask: Android, and desktop
      if (!prompt) return false;           // would have to ask, and may not — stay off
      try {
        if (await ask() !== 'granted') return false;
      } catch {
        return false;                      // denied, or called outside a gesture
      }
      return install();
    },

    disable() {
      gyroEnabled = false;
      gyroActive  = false;          // touch-drag look takes back over
      adoptCameraLook(camera);      // ...from where the gyro actually left us
    },

    recenter() { if (gyroRecenter) gyroRecenter(); },
  };
}

/**
 * Hand the camera's current orientation back to the drag-look bookkeeping.
 *
 * While the gyro drives, it writes camera.quaternion directly and `yaw`/`pitch`
 * go stale — so without this, switching motion OFF would snap the view to
 * wherever the last finger drag happened to leave it, which reads as the game
 * throwing you somewhere. Roll is dropped because drag-look has none to restore.
 */
function adoptCameraLook(camera) {
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  yaw   = e.y;
  pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, e.x));
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
    if (!gyroEnabled) return;     // the toggle is off; readings are ignored
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
