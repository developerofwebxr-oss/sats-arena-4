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
import { onPeerPose, onPeerJoin, onPeerLeave } from './room.js';
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
// Pose delta drives subtle head movement; clamp prevents runaway if world scales differ.
const _LO = new THREE.Vector3(-0.30, -0.20, -0.30);
const _HI = new THREE.Vector3( 0.30,  0.20,  0.30);

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
let _headGeo, _headMat, _handGeo, _handMat, _ringGeo, _phGeo, _phMat;

function _initShared() {
  if (_headGeo) return;
  _headGeo = new THREE.SphereGeometry(0.12, 12, 8);
  _headMat = new THREE.MeshStandardMaterial({ color: 0x44aaff, roughness: 0.6, metalness: 0.1 });
  _handGeo = new THREE.SphereGeometry(0.06, 8, 6);
  _handMat = new THREE.MeshStandardMaterial({ color: 0xffaa44, roughness: 0.7, metalness: 0 });
  _ringGeo = new THREE.TorusGeometry(0.16, 0.012, 6, 24);
  // Placeholder: bright green wireframe box — immediately obvious, needs no texture/light.
  _phGeo   = new THREE.BoxGeometry(0.40, 0.90, 0.20);
  _phMat   = new THREE.MeshBasicMaterial({ color: 0x00ff88, wireframe: true });
}

// ── Per-frame interpolation temporaries (no allocation in hot path) ──────────
const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

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

    // ── Head sphere (hidden until first pose) ─────────────────────────────────
    this.headMesh = new THREE.Mesh(_headGeo, _headMat.clone());
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
    sprite.position.set(0, 0.22, 0); // float above the head sphere
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

  _applyPose(msg) {
    if (!msg.head || !this._hasOrigin) return;
    this.headMesh.position.copy(this._headLocalPos(msg.head.p));
  }

  _applyInterpolated(a, b, t) {
    if (!a.head || !b.head || !this._hasOrigin) return;
    const pa = _pa.fromArray(a.head.p).sub(this._originPos).clamp(_LO, _HI);
    const pb = _pb.fromArray(b.head.p).sub(this._originPos).clamp(_LO, _HI);
    this.headMesh.position.lerpVectors(pa, pb, t);
    // Head rotation: interpolate the broadcast quaternion so the head nods/turns.
    this.headMesh.quaternion.slerpQuaternions(
      _qa.fromArray(a.head.q),
      _qb.fromArray(b.head.q),
      t,
    );
  }

  // ── Opacity ───────────────────────────────────────────────────────────────
  _setOpacity(v) {
    this._opacity = v;
    if (v <= 0) { this.root.visible = false; return; }
    this.root.visible = true;
    this.headMesh.material.transparent = true;
    this.headMesh.material.opacity     = v;
    this.handMesh.material.transparent = true;
    this.handMesh.material.opacity     = v;
    this.label.material.opacity = v;
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  dispose() {
    this.dead = true;
    this.scene.remove(this.root);
    // Dispose only per-instance materials/textures we created (not shared ones).
    this.headMesh.material.dispose();
    this.handMesh.material.dispose();
    this._ring.material.dispose();
    this.label.material.map.dispose();
    this.label.material.dispose();
    // GLB clone materials are shared with the loaded scene — do not dispose.
  }
}

// ── Manager ───────────────────────────────────────────────────────────────────

export function setupPeerAvatars(scene) {
  const peers    = new Map(); // identity → PeerAvatar
  let _nextSlot  = 0;

  onPeerJoin((identity, displayName) => {
    if (peers.has(identity)) return; // dedupe
    const slot = _nextSlot++;
    peers.set(identity, new PeerAvatar(identity, displayName, scene, slot));
    console.log(`[avatar] peer ${identity} (${displayName}) → slot ${slot}`);
  });

  onPeerLeave((identity) => {
    const av = peers.get(identity);
    if (!av) return;
    av.dispose();
    peers.delete(identity);
    console.log(`[avatar] peer ${identity} left — slot freed`);
  });

  onPeerPose((msg, identity, displayName) => {
    // Race: first pose can arrive before the join event.
    if (!peers.has(identity)) {
      const slot = _nextSlot++;
      peers.set(identity, new PeerAvatar(identity, displayName, scene, slot));
      console.log(`[avatar] peer ${identity} created at first pose → slot ${slot - 1}`);
    }
    peers.get(identity).pushPose(msg);
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
