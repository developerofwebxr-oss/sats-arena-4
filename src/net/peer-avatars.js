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

// ── Gun clone parameters (per hand) ───────────────────────────────────────────
// The raw GLB long-axis is X; rotate 90° Y so barrel faces hand-local −Z (toward player).
// Scale slightly smaller than player gun (0.50) to look right at arm's length.
const GUN_SCALE = 0.42;
const GUN_POS   = new THREE.Vector3(0, -0.12, 0.05); // hang slightly below + forward of hand
const GUN_EULER = new THREE.Euler(0, Math.PI / 2, 0); // barrel → local −Z

// ── Torso (floating chest, no legs) ───────────────────────────────────────────
// Torso is a child of root; its ORIGIN is at shoulder height and it is repositioned
// each frame just below the head node, upright, yaw-following the head. The chest
// mesh hangs downward from the shoulders and tapers to a rounded base.
const SHOULDER_DROP  = 0.30;   // shoulders sit this far below the head/eye centre (m)
const TORSO_HEIGHT   = 0.46;   // shoulders → base
const TORSO_TOP_R    = 0.19;   // shoulder-width radius
const TORSO_BOT_R    = 0.11;   // waist radius (tapers in)
const TORSO_RADIAL   = 12;     // low-poly

// ── Arms + hands (torso-LOCAL; −Z is forward, toward the viewer) ───────────────
// Shoulders sit at the top corners of the torso; hands rest out in front at arm's
// length. A tapered limb connects shoulder → hand; the gun lives at the hand.
const SHOULDER_X = 0.17;                              // shoulder offset from torso centre
const HAND_R     = new THREE.Vector3( 0.26, -0.10, -0.30); // right hand rest (torso-local)
const HAND_L     = new THREE.Vector3(-0.26, -0.10, -0.30); // left  hand rest (mirror X)
const ARM_R_SHOULDER = 0.055; // limb radius at the shoulder (thicker)
const ARM_R_WRIST    = 0.035; // limb radius at the wrist  (tapered)

// ── Shared geometry (allocated once per module lifetime) ─────────────────────
// Flat-faced head constants — faithful port from xr-stage/web/src/room/avatars.js.
const HEAD_RADIUS  = 0.22;
const HEAD_CUT_RAD = THREE.MathUtils.degToRad(128); // past-hemisphere; larger = smaller face opening
const _openingR    = HEAD_RADIUS * Math.sin(HEAD_CUT_RAD); // radius of the circular face disc
const _openingZ    = HEAD_RADIUS * Math.cos(HEAD_CUT_RAD); // z-offset of the disc (negative = forward)

// Head + body geometry is shared (same shape across all peers); MATERIALS are
// per-instance so each avatar's opacity fades independently.
let _skullGeo, _torsoGeo, _baseGeo, _ringGeo, _phGeo, _phMat;
let _faceGeo;

function _initShared() {
  if (_skullGeo) return;
  // Partial sphere: full phi sweep, theta from back pole down 128 degrees (past equator).
  _skullGeo = new THREE.SphereGeometry(HEAD_RADIUS, 24, 16, 0, Math.PI * 2, 0, HEAD_CUT_RAD);
  // Circle cap that exactly plugs the skull opening.
  _faceGeo  = new THREE.CircleGeometry(_openingR, 32);
  // Torso: tapered cylinder (wide shoulders → narrow waist), low-poly, open-ended
  // (the rounded base sphere caps the bottom; the top is hidden under the neck).
  _torsoGeo = new THREE.CylinderGeometry(TORSO_TOP_R, TORSO_BOT_R, TORSO_HEIGHT, TORSO_RADIAL, 1, true);
  // Rounded base — soft cap so the floating torso doesn't read as a cut-off tube.
  _baseGeo  = new THREE.SphereGeometry(TORSO_BOT_R, TORSO_RADIAL, 8);
  // Speaking ring scaled to new HEAD_RADIUS (was 0.16 for old radius 0.12).
  _ringGeo  = new THREE.TorusGeometry(HEAD_RADIUS * 1.25, 0.012, 6, 24);
  // Placeholder: bright green wireframe box — immediately obvious, needs no texture/light.
  _phGeo    = new THREE.BoxGeometry(0.40, 0.90, 0.20);
  _phMat    = new THREE.MeshBasicMaterial({ color: 0x00ff88, wireframe: true });
}

// Body material — blue-white sibling to the head (0xe8e8ef) with a faint cyan
// emissive so it reads sci-fi/Tron even without a bloom pass (SA4 has none).
// Cloned per avatar so opacity fades are independent.
function _makeBodyMat() {
  return new THREE.MeshStandardMaterial({
    color:             0xdfe8f2,
    roughness:         0.55,
    metalness:         0.10,
    emissive:          0x0a3a44, // faint cyan glow in shadow
    emissiveIntensity: 1.0,
  });
}

// Tapered limb between two torso-LOCAL points (shoulder → hand). Returns a Mesh
// oriented along the connector; thicker at the shoulder, thinner at the wrist.
// Static (does not rotate with aim) — reads as an arm leading to the gun.
function _makeLimb(a, b, mat) {
  const dir = _limbDir.copy(b).sub(a);
  const len = dir.length();
  // Cylinder axis is +Y: top (+Y) → b (wrist, thin), bottom → a (shoulder, thick).
  const geo  = new THREE.CylinderGeometry(ARM_R_WRIST, ARM_R_SHOULDER, len, 8, 1, true);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);       // midpoint
  mesh.quaternion.setFromUnitVectors(_UP, dir.normalize()); // +Y → connector direction
  return mesh;
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
// Body/limb helpers (module-level so _makeLimb + torso yaw don't allocate)
const _limbDir = new THREE.Vector3();
const _UP      = new THREE.Vector3(0, 1, 0);
const _yawE    = new THREE.Euler(0, 0, 0, 'YXZ');

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

    // ── Body material (per-avatar, for independent opacity fade) ──────────────
    this._bodyMat = _makeBodyMat();

    // ── Floating torso (child of root; repositioned under the head each frame) ─
    // Origin at shoulder height; chest hangs downward and tapers to a rounded base.
    this.torso = new THREE.Group();
    this.torso.visible = false; // shown with the rest of the body on first pose
    const chest = new THREE.Mesh(_torsoGeo, this._bodyMat);
    chest.position.y = -TORSO_HEIGHT / 2; // top (shoulders) at torso origin
    const base = new THREE.Mesh(_baseGeo, this._bodyMat);
    base.position.y = -TORSO_HEIGHT;      // rounded cap at the bottom
    this.torso.add(chest, base);
    this.root.add(this.torso);

    // ── Arms + hands ──────────────────────────────────────────────────────────
    // Two arm units (right, left). Each: a static tapered limb (shoulder → hand)
    // plus an invisible hand pivot that holds a gun and rotates to track aim.
    // The gun-holding sphere is GONE — the arm now leads to the gun.
    // Right = index 0 (always shown for a peer with ≥1 gun); left = index 1
    // (shown only for a dual-wield / both-headset peer publishing a 2nd hand).
    this.arms = [
      this._makeArmUnit(new THREE.Vector3( SHOULDER_X, 0, 0), HAND_R, identity),
      this._makeArmUnit(new THREE.Vector3(-SHOULDER_X, 0, 0), HAND_L, identity),
    ];
    // Muzzle origin for peer-shot VFX stays the RIGHT gun (index 0) — keeps
    // fireFromGun / lightning behaviour identical to before.
    this._gunGroup = this.arms[0].gunGroup;
  }

  // Build one arm unit: static limb (child of torso) + hand pivot (child of torso)
  // holding a gun clone. Hidden until pose/visibility says otherwise.
  _makeArmUnit(shoulder, hand, identity) {
    const arm = _makeLimb(shoulder, hand, this._bodyMat);
    arm.visible = false;
    this.torso.add(arm);

    const pivot = new THREE.Group();     // invisible — no sphere; just holds the gun
    pivot.position.copy(hand);
    pivot.visible = false;
    this.torso.add(pivot);

    const gunGroup = new THREE.Group();
    gunGroup.position.copy(GUN_POS);
    gunGroup.rotation.copy(GUN_EULER);
    gunGroup.scale.setScalar(GUN_SCALE);
    pivot.add(gunGroup);

    cloneGun().then((model) => {
      if (this.dead) return; // disposed before the gun loaded — skip
      gunGroup.add(model);
    });

    return { arm, pivot, gunGroup };
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
      this.torso.visible = true; // arms/guns reveal per-hand in _applyHands
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

  // Keep the torso just below the head, upright, yaw-following the head. Called
  // after the head position/quaternion are set for the frame. Upright = no pitch/
  // roll; only the head's yaw is copied so head + torso read as one figure.
  _updateTorso() {
    this.torso.position.set(
      this.headMesh.position.x,
      this.headMesh.position.y - SHOULDER_DROP,
      this.headMesh.position.z,
    );
    _yawE.setFromQuaternion(this.headMesh.quaternion); // 'YXZ' → .y is yaw
    this.torso.rotation.set(0, _yawE.y, 0);
  }

  // Orient a hand pivot so its gun barrel tracks the peer's aim direction.
  // hands[i].q is the world quaternion of the peer's camera (flat) or controller
  // (VR); the gun barrel lies along the pivot's local -Z, so lookAt(pos + aimDir)
  // faces the barrel down the aim. The arm limb is static and does not rotate.
  _applyAimPivot(pivot, aimWorldQ) {
    _aimDir.set(0, 0, -1).applyQuaternion(aimWorldQ);
    pivot.getWorldPosition(_pa);
    _pa.addScaledVector(_aimDir, 1.0);
    pivot.lookAt(_pa);
  }

  // Show/aim an arm+gun per published hand; hide arms with no hand data.
  // Right = index 0 (any peer with a gun); left = index 1 (dual-wield peer with a
  // 2nd published hand). handsB/t optional (used for interpolation).
  _applyHands(handsA, handsB, t) {
    for (let i = 0; i < this.arms.length; i++) {
      const a = handsA && handsA[i];
      const b = handsB && handsB[i];
      const unit = this.arms[i];
      if (!a && !b) { unit.arm.visible = false; unit.pivot.visible = false; continue; }
      unit.arm.visible   = true;
      unit.pivot.visible = true;
      if (a && b) _aimQ.slerpQuaternions(_qa.fromArray(a.q), _qb.fromArray(b.q), t);
      else        _aimQ.fromArray((a || b).q);
      this._applyAimPivot(unit.pivot, _aimQ);
    }
  }

  _applyPose(msg) {
    if (!msg.head || !this._hasOrigin) return;
    this.headMesh.position.copy(this._headLocalPos(msg.head.p));
    this.headMesh.position.y = this._headLocalY(); // vertical from floor-relative eyeY
    if (msg.head.q) this.headMesh.quaternion.fromArray(msg.head.q); // keep yaw fresh for the torso
    this._updateTorso();
    this._applyHands(msg.hands, null, 0);
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
    this._updateTorso();
    // Arms/guns: slerp each present hand's aim (reuses _qa/_qb after the head slerp).
    this._applyHands(a.hands, b.hands, t);
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
    // headMesh is a Group (skull + faceMount) — traverse all child meshes.
    this.headMesh.traverse((o) => {
      if (o.isMesh && o.material) { o.material.transparent = true; o.material.opacity = v; }
    });
    // Torso + both arms share the per-avatar body material — one set fades all.
    this._bodyMat.transparent = true;
    this._bodyMat.opacity     = v;
    this.label.material.opacity = v;
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  dispose() {
    this.dead = true;
    this.scene.remove(this.root);
    // Dispose per-instance materials (skull + faceMount); geometry is shared — do not dispose.
    this.headMesh.traverse((o) => { if (o.isMesh && o.material) o.material.dispose(); });
    this._bodyMat.dispose();              // torso + arms (shared per-avatar)
    // Per-avatar arm limb GEOMETRY (built per instance in _makeLimb) — dispose it.
    this.arms.forEach((u) => u.arm.geometry.dispose());
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
