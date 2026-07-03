/**
 * pose-publisher.js — reads local head + hand pose every frame and
 * throttles sendPose() to ~15 Hz over the lossy data channel.
 *
 * VR:   head = XR camera, hands = controller[0,1]
 * flat: head = flat camera, "hand" = aim point 1m in front of camera
 * AR:   same as VR when controllers present, else same as flat
 */

import * as THREE from 'three';
import { sendPose } from './room.js';

const HZ       = 15;
const INTERVAL = 1 / HZ;

// Module-level reusable temporaries — no per-frame allocation
const _vec3 = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _fwd  = new THREE.Vector3();

// Monotonic sequence counter — included in every packet for stale-packet guard.
let _seq = 0;

function objToJoint(obj) {
  obj.getWorldPosition(_vec3);
  obj.getWorldQuaternion(_quat);
  return {
    p: [_vec3.x, _vec3.y, _vec3.z],
    q: [_quat.x, _quat.y, _quat.z, _quat.w],
  };
}

function aimJoint(cam) {
  cam.getWorldPosition(_vec3);
  cam.getWorldQuaternion(_quat);
  _fwd.set(0, 0, -1).applyQuaternion(_quat);
  _vec3.add(_fwd);
  return {
    p: [_vec3.x, _vec3.y, _vec3.z],
    q: [_quat.x, _quat.y, _quat.z, _quat.w],
  };
}

export function setupPosePublisher(renderer, camera, modeCtrl) {
  let elapsed = 0;
  let currentMode = 'screen';
  let eyeOffset   = 0; // added to the raw XR camera Y when only a 'local' space exists

  modeCtrl.subscribe((state) => {
    currentMode = state.activeMode;
    eyeOffset   = state.eyeOffset || 0;
  });

  return function publishPose(delta) {
    elapsed += delta;
    if (elapsed < INTERVAL) return;
    elapsed -= INTERVAL;

    const isVR = currentMode === 'vr' || currentMode === 'ar';

    let head, hands, dualCapable, eyeY;

    if (isVR && renderer.xr.isPresenting) {
      const xrCam = renderer.xr.getCamera();
      head  = objToJoint(xrCam);
      // Floor-relative eye height: XR camera Y (floor-relative under local-floor/
      // bounded-floor) plus eyeOffset (only non-zero when we fell back to 'local').
      eyeY  = head.p[1] + eyeOffset;
      const c0 = renderer.xr.getController(0);
      const c1 = renderer.xr.getController(1);
      hands = [];
      if (c0.children.length > 0 || c0.visible) hands.push(objToJoint(c0));
      if (c1.children.length > 0 || c1.visible) hands.push(objToJoint(c1));
      // dualCapable = true when physical tracked controllers are present.
      // Set BEFORE the aimJoint fallback so the flag isn't confused by it.
      dualCapable = hands.length > 0;
      if (hands.length === 0) hands = [aimJoint(xrCam)]; // handheld phone AR
    } else {
      head  = objToJoint(camera);
      hands = [aimJoint(camera)];
      eyeY  = head.p[1];  // flat camera is already floor-relative standing eye height (1.6)
      dualCapable = false; // flat / mobile / gaze
    }

    // eyeY is the ONE height convention shared by every mode: floor-relative eye
    // height (floor at Y=0). head.p keeps raw world Y for the renderer's XZ delta;
    // the renderer drives the head's vertical position from eyeY.
    sendPose({ seq: ++_seq, mode: currentMode, head, hands, dualCapable, eyeY });
  };
}
