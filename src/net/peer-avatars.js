/**
 * peer-avatars.js — render remote players as visible bodies at fixed standing marks.
 *
 * Design (Phase 2 presence):
 *   • Each peer occupies a numbered FIXED SLOT a few metres in front of the local
 *     player, facing toward the player's default eye position. World position from
 *     the pose stream is NOT used for placement — this avoids the shared-world
 *     problem entirely for now.
 *   • Render order:
 *       1. Bright wireframe placeholder appears IMMEDIATELY on peer join (no pose needed).
 *          Proves the render path before the first pose arrives.
 *       2. Once the first pose arrives, swap placeholder → real body:
 *          head sphere + name label + right-hand sphere + bitcoin gun clone.
 *       3. Head position is driven by the LOCAL DELTA from the peer's first-pose
 *          origin (clamped ±0.3 m), giving subtle head bob and lean.
 *       4. Right hand is static at a sensible rest position. The gun clone is
 *          a child of the hand sphere. No LEFT hand (left-gun orientation fix
 *          is still outstanding — defer as instructed).
 *   • Hardening carried over from Phase 1:
 *       - Stale-packet guard (seq): drop packets older than highest-seen seq.
 *       - Staleness timeout → fade → remove (STALE_TIMEOUT + FADE_SECS).
 *       - Speaking ring (torus) pulses when the peer's speaking flag is set.
 *       - 100 ms dejitter buffer + slerp interpolation for the head.
 *   • Multi-peer: each peer gets its own slot (index assigned at join/first-pose).
 *     Slots are not recycled within a session; ghosts are removed on leave/stale.
 */

import * as THREE from 'three';
import { onPeerPose, onPeerJoin, onPeerLeave, onPeerEvent } from './room.js';
import { cloneGun } from '../weapon.js';

// ── Slot layout ───────────────────────────────────────────────────────────────
// Peers stand at fixed world positions and face toward LOOK_AT (the player's
// default eye height). Slot 0 is straight ahead; additional slots arc outward.
const LOOK_AT   = new THREE.Vector3(0, 1.6, 0); // player's default eye position
const EYE_Y     = 1.6;
const PEER_SLOTS = [
  new THREE.Vector3( 0,   EYE_Y, -3),  // slot 0: straight ahead
  new THREE.Vector3( 3,   EYE_Y, -1),  // slot 1: right-forward
  new THREE.Vector3(-3,   EYE_Y, -1),  // slot 2: left-forward
  new THREE.Vector3( 0,   EYE_Y, -5),  // slot 3: further ahead
];

// ── Timing ────────────────────────────────────────────────────────────────────
const BUFFER_DELAY  = 0.10; // seconds of interpolation lag (dejitter)
const STALE_TIMEOUT = 3.0;  // seconds of silence before fade starts
const FADE_SECS     = 1.5;  // fade duration

// ── Head local-offset clamp ───────────────────────────────────────────────────
// Pose delta drives subtle head XZ movement; clamp prevents runaway if scales differ.
const _LO = new THREE.Vector3(-0.30, -0.20, -0.30);
const _HI = new THREE.Vector3( 0.30,  0.20,  0.30);

// ── Floor-relative eye-height clamp ───────────────────────────────────────────
// The head's VERTICAL position is driven by the peer's published floor-relative
// eye height (eyeY), not the XZ origin-delta. Clamp to a sane human range so a
// mis-calibrated peer can't sink through the floor or fly to the ceiling.
const EYE_Y_MIN = 0.8;
const EYE_Y_MAX = 2.2;

// ── Gun clone parameters (for right-hand gun) ─────────────────────────────────
// The raw GLB long-axis is X; rotate 90° Y so barrel faces root-local −Z (toward player).
// Scale slightly smaller than player gun (0.50) to look right at arm's length.
const GUN_SCALE = 0.42;
const GUN_POS   = new THREE.Vector3(0, -0.12, 0.05); // hang slightly below + forward of hand
const GUN_EULER = new THREE.Euler(0, Math.PI / 2, 0); // barrel → local −Z

// Right hand resting position in root-LOCAL space:
//   +0.28 X = peer's right (their dominant hand), −0.38 Y = below shoulder,
//   −0.20 Z = slightly forward (toward player)
const HAND_REST = new THREE.Vector3(0.28, -0.38, -0.20);

// ── Shared geometry (allocated once per module lifetime) ─────────────────────
// Flat-faced head constants — faithful port from xr-stage/web/src/room/avatars.js.
const HEAD_RADIUS  = 0.22;
const HEAD_CUT_RAD = THREE.MathUtils.degToRad(128); // past-hemisphere; larger = smaller face opening
const _openingR    = HEAD_RADIUS * Math.sin(HEAD_CUT_RAD); // radius of the circular face disc
const _openingZ    = HEAD_RADIUS * Math.cos(HEAD_CUT_RAD); // z-offset of the disc (negative = forward)

// Head geometry is shared (same shape across all peers); materials are per-instance
// inside _makeHead() so each avatar's opacity fades independently.
let _skullGeo, _faceGeo, _handGeo, _handMat, _ringGeo, _phGeo, _phMat;

function _initShared() {
  if (_skullGeo) return;
  // Partial sphere: full phi sweep, theta from back pole down 128 degrees (past equator).
  _skullGeo = new THREE.SphereGeometry(HEAD_RADIUS, 24, 16, 0, Math.PI * 2, 0, HEAD_CUT_RAD);
  // Circle cap that exactly plugs the skull opening.
  _faceGeo  = new THREE.CircleGeometry(_openingR, 32);
  _handGeo  = new THREE.SphereGeometry(0.06, 8, 6);
  _handMat  = new THREE.MeshStandardMaterial({ color: 0xffaa44, roughness: 0.7, metalness: 0 });
  // Speaking ring scaled to new HEAD_RADIUS (was 0.16 for old radius 0.12).
  _ringGeo  = new THREE.TorusGeometry(HEAD_RADIUS * 1.25, 0.012, 6, 24);
  // Placeholder: bright green wireframe box — immediately obvious, needs no texture/light.
  _phGeo    = new THREE.BoxGeometry(0.40, 0.90, 0.20);
  _phMat    = new THREE.MeshBasicMaterial({ color: 0x00ff88, wireframe: true });
}

// Ported verbatim from xr-stage makeHead() — same shape, proportions, materials.
// Returns a THREE.Group containing skull (rounded back) + faceMount (flat disc cap).
//
// To swap in a real profile image later (one-liner):
//   const fm = headGroup.getObjectByName('faceMount');
//   fm.material.map = new THREE.TextureLoader().load(url);
//   fm.material.map.colorSpace = THREE.SRGBColorSpace;
//   fm.material.color.set(0xffffff);
//   fm.material.needsUpdate = true;
function _makeHead() {
  _initShared();
  const head = new THREE.Group();

  // Rounded back hemisphere. rotation.x = PI/2 rotates the +Y pole to +Z (back of head),
  // so the skull's opening faces -Z (forward, toward the player looking at this peer).
  const skull = new THREE.Mesh(
    _skullGeo,
    new THREE.MeshStandardMaterial({ color: 0xe8e8ef, roughness: 0.6 }),
  );
  skull.rotation.x = Math.PI / 2;
  head.add(skull);

  // Flat face disc — caps the skull opening, flush at openingZ, facing forward (-Z).
  const faceMount = new THREE.Mesh(
    _faceGeo,
    new THREE.MeshStandardMaterial({ color: 0x222a3a, roughness: 0.85, metalness: 0 }),
  );
  faceMount.name       = 'faceMount';
  faceMount.rotation.y = Math.PI;   // CircleGeometry faces +Z by default; flip to face -Z
  faceMount.position.z = _openingZ; // flush with the skull's circular opening
  head.add(faceMount);

  // SA4 drives head.position via pose delta, so head.position.y is NOT set here.
  return head;
}

// ── Per-frame interpolation temporaries (no allocation in hot path) ──────────
const _pa      = new THREE.Vector3();
const _pb      = new THREE.Vector3();
const _qa      = new THREE.Quaternion();
const _qb      = new THREE.Quaternion();
// Aim tracking — used in _applyAim and peer shot handler
const _aimDir  = new THREE.Vector3();
const _aimQ    = new THREE.Quaternion();
const _muzzle  = new THREE.Vector3();
const _shotDir = new THREE.Vector3();

// ── PeerAvatar ────────────────────────────────────────────────────────────────

class PeerAvatar {
  constructor(identity, displayName, scene, slotIndex) {
    _initShared();
    this.identity    = identity;
    this.displayName = displayName;
    this.scene       = scene;
    this.poseBuffer  = [];
    this.dead        = false;

    this._maxSeq      = -1;
    this._lastRecvSec = null;
    this._opacity     = 1.0;
    this._speaking    = false;
    this._hasOrigin   = false;
    this._originPos   = new THREE.Vector3();
    // Floor-relative eye height (metres). null until the first pose carrying eyeY;
    // falls back to EYE_Y so pre-eyeY clients still render at standing height.
    this._eyeY        = null;
    // Fairness gate: null = unknown (don't penalise yet), true/false = known.
    this.dualCapable     = null;
    this._notifyCompose  = null; // set by the manager after construction

    // ── Root group: anchored at fixed slot, facing the player ─────────────────
    const slotPos = PEER_SLOTS[slotIndex % PEER_SLOTS.length];
    this.root = new THREE.Group();
    this.root.position.copy(slotPos);
    this.root.lookAt(LOOK_AT); // peer faces the player's default eye point
    scene.add(this.root);

    // ── Placeholder: bright wireframe box, visible immediately on join ────────
    // No pose required — proves the avatar lifecycle (appear/disappear) before
    // the first pose packet arrives.
    this._ph = new THREE.Mesh(_phGeo, _phMat);
    this._ph.position.set(0, -0.45, 0); // centre the box at torso (head is above)
    this.root.add(this._ph);

    // ── Flat-faced head group (hidden until first pose) ───────────────────────
    // Returns a THREE.Group with skull + faceMount — drop-in for the old sphere.
    // All downstream code (pose position/quaternion, ring, label) still uses this.headMesh.
    this.headMesh = _makeHead();
    this.headMesh.visible = false;
    this.root.add(this.headMesh);

    // Speaking ring — lays flat (horizontal) around the head.
    this._ring = new THREE.Mesh(
      _ringGeo,
      new THREE.MeshBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0 }),
    );
    this._ring.rotation.x = Math.PI / 2;
    this.headMesh.add(this._ring);

    // Name label — billboarded sprite, child of head so it moves with it.
    this.label = this._makeLabel(displayName);
    this.headMesh.add(this.label);

    // ── Right hand sphere ─────────────────────────────────────────────────────
    this.handMesh = new THREE.Mesh(_handGeo, _handMat.clone());
    this.handMesh.position.copy(HAND_REST);
    this.handMesh.visible = false;
    this.root.add(this.handMesh);

    // ── Gun pivot — child of right hand ───────────────────────────────────────
    // Position/rotation applied here; the raw GLB model is added once loaded.
    this._gunGroup = new THREE.Group();
    this._gunGroup.position.copy(GUN_POS);
    this._gunGroup.rotation.copy(GUN_EULER);
    this._gunGroup.scale.setScalar(GUN_SCALE);
    this.handMesh.add(this._gunGroup);

    cloneGun().then((model) => {
      if (this.dead) return; // avatar was disposed before the gun loaded — skip
      this._gunGroup.add(model);
      console.log(`[avatar] gun cloned for peer ${identity}`);
    });
  }

  // ── Label (billboarded sprite) ────────────────────────────────────────────
  _makeLabel(name) {
    const canvas = document.createElement('canvas');
    canvas.width  = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#7df';
    ctx.font = 'bold 28px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name.slice(0, 16), 128, 32);
    const tex    = new THREE.CanvasTexture(canvas);
    const mat    = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.6, 0.15, 1);
    sprite.position.set(0, HEAD_RADIUS + 0.13, 0); // float above the head (HEAD_RADIUS + margin)
    return sprite;
  }

  // ── Receive a pose packet ─────────────────────────────────────────────────
  pushPose(msg) {
    // Stale-packet guard: drop anything out-of-order.
    if (msg.seq !== undefined) {
      if (msg.seq <= this._maxSeq) return;
      this._maxSeq = msg.seq;
    }

    const recvSec = performance.now() / 1000;
    this._lastRecvSec = recvSec;

    // First pose: record origin and swap placeholder → real body.
    if (!this._hasOrigin && msg.head) {
      this._originPos.fromArray(msg.head.p);
      this._hasOrigin = true;
      this._ph.visible = false;
      this.headMesh.visible = true;
      this.handMesh.visible = true;
    }

    this.poseBuffer.push({ time: recvSec, msg });

    // Bound buffer to last 2 s of packets.
    const cutoff = recvSec - 2;
    while (this.poseBuffer.length > 2 && this.poseBuffer[0].time < cutoff) {
      this.poseBuffer.shift();
    }

    if (msg.speaking !== undefined) this._speaking = msg.speaking;
    if (msg.eyeY !== undefined)     this._eyeY    = msg.eyeY;

    // Track dualCapable for the fairness gate. Notify the manager only on change
    // so recomputation is cheap (one call per state transition, not 15 Hz).
    if (msg.dualCapable !== undefined && msg.dualCapable !== this.dualCapable) {
      this.dualCapable = msg.dualCapable;
      this._notifyCompose?.();
    }
  }

  // ── Per-frame update ──────────────────────────────────────────────────────
  update(nowSec) {
    // Staleness / fade
    if (this._lastRecvSec !== null) {
      const age = nowSec - this._lastRecvSec;
      if (age > STALE_TIMEOUT + FADE_SECS) { this.dead = true; return; }
      if (age > STALE_TIMEOUT) {
        this._setOpacity(1 - (age - STALE_TIMEOUT) / FADE_SECS);
      } else if (this._opacity < 1) {
        this._setOpacity(1);
      }
    }

    // Speaking ring pulse
    this._ring.material.opacity = this._speaking
      ? 0.45 + 0.35 * Math.sin(nowSec * Math.PI * 4)
      : 0;

    // Interpolate from the dejitter buffer
    const target = nowSec - BUFFER_DELAY;
    const buf    = this.poseBuffer;
    if (buf.length === 0) return;

    let before = null, after = null;
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].time <= target && buf[i + 1].time >= target) {
        before = buf[i]; after = buf[i + 1]; break;
      }
    }

    if (!before) {
      const s = buf[buf.length - 1];
      if (s.time > target + 0.5) return; // too far ahead, wait
      this._applyPose(s.msg);
    } else {
      const t = (target - before.time) / (after.time - before.time);
      this._applyInterpolated(before.msg, after.msg, t);
    }
  }

  // ── Pose application ──────────────────────────────────────────────────────
  // Head position = LOCAL DELTA from peer's first-pose origin, clamped ±0.3 m.
  // This keeps the avatar at the fixed slot while showing subtle head movement.

  _headLocalPos(worldP) {
    return _pa.fromArray(worldP).sub(this._originPos).clamp(_LO, _HI);
  }

  // Head vertical position, LOCAL to the root slot. Driven by the peer's published
  // floor-relative eye height (eyeY), NOT the XZ origin-delta. root.position.y is
  // EYE_Y, and the scene floor is Y=0, so the local Y that puts the head at world
  // height `eyeY` is (eyeY - EYE_Y). Falls back to EYE_Y (→ local 0) if no eyeY yet.
  _headLocalY() {
    const y = this._eyeY == null ? EYE_Y : this._eyeY;
    return THREE.MathUtils.clamp(y, EYE_Y_MIN, EYE_Y_MAX) - EYE_Y;
  }

  // Orient the hand+gun so the barrel tracks the peer's aim direction.
  // hands[0].q is the world quaternion of the peer's camera (flat) or right
  // controller (VR) — the gun barrel lies along handMesh local -Z, so
  // handMesh.lookAt(worldPos + aimDir) makes the barrel face the aim direction.
  _applyAim(aimWorldQ) {
    _aimDir.set(0, 0, -1).applyQuaternion(aimWorldQ);
    this.handMesh.getWorldPosition(_pa);
    _pa.addScaledVector(_aimDir, 1.0);
    this.handMesh.lookAt(_pa);
  }

  _applyPose(msg) {
    if (!msg.head || !this._hasOrigin) return;
    this.headMesh.position.copy(this._headLocalPos(msg.head.p));
    this.headMesh.position.y = this._headLocalY(); // vertical from floor-relative eyeY
    if (msg.hands?.[0]) this._applyAim(_aimQ.fromArray(msg.hands[0].q));
  }

  _applyInterpolated(a, b, t) {
    if (!a.head || !b.head || !this._hasOrigin) return;
    const pa = _pa.fromArray(a.head.p).sub(this._originPos).clamp(_LO, _HI);
    const pb = _pb.fromArray(b.head.p).sub(this._originPos).clamp(_LO, _HI);
    this.headMesh.position.lerpVectors(pa, pb, t);
    this.headMesh.position.y = this._headLocalY(); // vertical from floor-relative eyeY
    // Head rotation: interpolate the broadcast quaternion so the head nods/turns.
    this.headMesh.quaternion.slerpQuaternions(
      _qa.fromArray(a.head.q),
      _qb.fromArray(b.head.q),
      t,
    );
    // Gun aim: slerp between the two aim quaternions (reuses _qa/_qb after head).
    if (a.hands?.[0] && b.hands?.[0]) {
      _aimQ.slerpQuaternions(
        _qa.fromArray(a.hands[0].q),
        _qb.fromArray(b.hands[0].q),
        t,
      );
      this._applyAim(_aimQ);
    }
  }

  // Trigger the peer shot VFX from this avatar's gun world position.
  // spawnLightning is only passed when msg.rapidFire === true.
  fireFromGun(dir, spawnPeerShot, spawnLightning) {
    if (!this._hasOrigin) return;
    this._gunGroup.getWorldPosition(_muzzle);
    if (spawnPeerShot) spawnPeerShot(_muzzle.clone(), dir);
    if (spawnLightning) {
      const boltEnd = _muzzle.clone().addScaledVector(dir, 5.0);
      spawnLightning(_muzzle.clone(), boltEnd);
    }
  }

  // ── Opacity ───────────────────────────────────────────────────────────────
  _setOpacity(v) {
    this._opacity = v;
    if (v <= 0) { this.root.visible = false; return; }
    this.root.visible = true;
    // headMesh is now a Group (skull + faceMount) — traverse all child meshes.
    this.headMesh.traverse((o) => {
      if (o.isMesh && o.material) { o.material.transparent = true; o.material.opacity = v; }
    });
    this.handMesh.material.transparent = true;
    this.handMesh.material.opacity     = v;
    this.label.material.opacity = v;
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  dispose() {
    this.dead = true;
    this.scene.remove(this.root);
    // Dispose per-instance materials (skull + faceMount); geometry is shared — do not dispose.
    this.headMesh.traverse((o) => { if (o.isMesh && o.material) o.material.dispose(); });
    this.handMesh.material.dispose();
    this._ring.material.dispose();
    this.label.material.map.dispose();
    this.label.material.dispose();
    // GLB clone materials are shared with the loaded scene — do not dispose.
  }
}

// ── Manager ───────────────────────────────────────────────────────────────────

export function setupPeerAvatars(scene, { spawnPeerShot, spawnLightning, onCompositionChange } = {}) {
  const peers    = new Map(); // identity → PeerAvatar
  let _nextSlot  = 0;

  // Recompute the fairness flag whenever peer composition changes.
  // anyFlat = true when at least one peer is confirmed non-dual-capable (flat screen).
  // Peers with dualCapable === null (unknown) are treated as dual — don't penalise
  // until we have a confirmed 'false' from their first pose packet.
  function _recompute() {
    const anyFlat = [...peers.values()].some(av => av.dualCapable === false);
    onCompositionChange?.(anyFlat);
  }

  function _addPeer(identity, displayName) {
    const slot = _nextSlot++;
    const av   = new PeerAvatar(identity, displayName, scene, slot);
    av._notifyCompose = _recompute; // wire the per-peer callback
    peers.set(identity, av);
    return { slot, av };
  }

  onPeerJoin((identity, displayName) => {
    if (peers.has(identity)) return; // dedupe
    const { slot } = _addPeer(identity, displayName);
    console.log(`[avatar] peer ${identity} (${displayName}) → slot ${slot}`);
    // dualCapable is null at join — no recompute yet (don't penalise the unknown).
  });

  onPeerLeave((identity) => {
    const av = peers.get(identity);
    if (!av) return;
    av.dispose();
    peers.delete(identity);
    console.log(`[avatar] peer ${identity} left — slot freed`);
    _recompute(); // may restore left gun if the flat peer was the last one
  });

  onPeerPose((msg, identity, displayName) => {
    // Race: first pose can arrive before the join event.
    if (!peers.has(identity)) {
      const { slot } = _addPeer(identity, displayName);
      console.log(`[avatar] peer ${identity} created at first pose → slot ${slot - 1}`);
    }
    peers.get(identity).pushPose(msg); // pushPose calls _recompute on dualCapable change
  });

  onPeerEvent((msg, identity) => {
    if (msg.t !== 'shot') return;
    const av = peers.get(identity);
    if (!av) return;
    _shotDir.fromArray(msg.dir).normalize();
    av.fireFromGun(_shotDir, spawnPeerShot, msg.rapidFire ? spawnLightning : null);
  });

  return {
    updatePeers(_delta) {
      const nowSec = performance.now() / 1000;
      for (const [id, av] of peers) {
        av.update(nowSec);
        if (av.dead) {
          av.dispose();
          peers.delete(id);
          console.log(`[avatar] removed stale peer ${id}`);
        }
      }
    },
  };
}
