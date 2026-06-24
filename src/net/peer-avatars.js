/**
 * peer-avatars.js — render remote players as head + hand markers + name label.
 *
 * Receives poses from room.js via onPeerPose / onPeerJoin / onPeerLeave.
 * Uses a ~100 ms interpolation buffer (lerp pos, slerp rot).
 * Never touches the gun system.
 */

import * as THREE from 'three';
import { onPeerPose, onPeerJoin, onPeerLeave } from './room.js';

const BUFFER_DELAY = 0.1; // seconds of interpolation lag

// ── Avatar geometry (shared across all peers) ────────────────────────────────
let headGeo, headMat, handGeo, handMat;

function getShared() {
  if (!headGeo) {
    headGeo = new THREE.SphereGeometry(0.12, 12, 8);
    headMat = new THREE.MeshStandardMaterial({ color: 0x44aaff, roughness: 0.6, metalness: 0.1 });
    handGeo = new THREE.SphereGeometry(0.05, 8, 6);
    handMat = new THREE.MeshStandardMaterial({ color: 0xffaa44, roughness: 0.7, metalness: 0 });
  }
  return { headGeo, headMat, handGeo, handMat };
}

// ── Single peer ───────────────────────────────────────────────────────────────

class PeerAvatar {
  constructor(identity, displayName, scene) {
    this.identity = identity;
    this.displayName = displayName;
    this.scene = scene;
    this.poseBuffer = []; // [{ time, head, hands }]

    const { headGeo, headMat, handGeo, handMat } = getShared();

    this.headMesh = new THREE.Mesh(headGeo, headMat.clone());
    this.headMesh.visible = false;
    scene.add(this.headMesh);

    this.handMeshes = [];
    this.handGroup = new THREE.Group();
    scene.add(this.handGroup);

    this.label = this._makeLabel(displayName);
    this.headMesh.add(this.label);

    this._headGeo = headGeo;
    this._handGeo = handGeo;
    this._handMat = handMat;
  }

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

    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.6, 0.15, 1);
    sprite.position.set(0, 0.22, 0);
    return sprite;
  }

  pushPose(msg) {
    this.poseBuffer.push({ time: performance.now() / 1000, msg });
    // Keep buffer bounded (2s max)
    const cutoff = performance.now() / 1000 - 2;
    while (this.poseBuffer.length > 2 && this.poseBuffer[0].time < cutoff) {
      this.poseBuffer.shift();
    }
  }

  _ensureHands(count) {
    const { _handGeo, _handMat } = this;
    while (this.handMeshes.length < count) {
      const m = new THREE.Mesh(_handGeo, _handMat.clone());
      m.visible = false;
      this.handGroup.add(m);
      this.handMeshes.push(m);
    }
    // Hide extras
    for (let i = count; i < this.handMeshes.length; i++) {
      this.handMeshes[i].visible = false;
    }
  }

  update(now) {
    // Target time = now - BUFFER_DELAY
    const target = now - BUFFER_DELAY;

    // Need at least 2 samples to interpolate; or 1 sample older than target
    const buf = this.poseBuffer;
    if (buf.length === 0) return;

    let before = null, after = null;
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].time <= target && buf[i + 1].time >= target) {
        before = buf[i];
        after  = buf[i + 1];
        break;
      }
    }

    // If no bracket found, extrapolate from latest sample
    if (!before) {
      const sample = buf[buf.length - 1];
      if (sample.time > target + 0.5) return; // too far in the future, wait
      this._applyPose(sample.msg, 1);
      return;
    }

    const t = (target - before.time) / (after.time - before.time);
    this._applyInterpolated(before.msg, after.msg, t);
  }

  _applyPose(msg, _t) {
    if (!msg.head) return;
    const { head, hands } = msg;
    this.headMesh.visible = true;
    this.headMesh.position.fromArray(head.p);
    this.headMesh.quaternion.fromArray(head.q);

    const handCount = hands ? hands.length : 0;
    this._ensureHands(handCount);
    if (hands) {
      hands.forEach((h, i) => {
        this.handMeshes[i].visible = true;
        this.handMeshes[i].position.fromArray(h.p);
        this.handMeshes[i].quaternion.fromArray(h.q);
      });
    }
  }

  _applyInterpolated(a, b, t) {
    if (!a.head || !b.head) return;

    this.headMesh.visible = true;
    this.headMesh.position.lerpVectors(
      _v3a.fromArray(a.head.p),
      _v3b.fromArray(b.head.p),
      t
    );
    this.headMesh.quaternion.slerpQuaternions(
      _qa.fromArray(a.head.q),
      _qb.fromArray(b.head.q),
      t
    );

    const handCount = Math.max(
      a.hands ? a.hands.length : 0,
      b.hands ? b.hands.length : 0
    );
    this._ensureHands(handCount);

    const aHands = a.hands || [];
    const bHands = b.hands || [];
    for (let i = 0; i < handCount; i++) {
      const ha = aHands[i], hb = bHands[i];
      if (!ha && !hb) continue;
      this.handMeshes[i].visible = true;
      if (ha && hb) {
        this.handMeshes[i].position.lerpVectors(_v3a.fromArray(ha.p), _v3b.fromArray(hb.p), t);
        this.handMeshes[i].quaternion.slerpQuaternions(_qa.fromArray(ha.q), _qb.fromArray(hb.q), t);
      } else {
        const h = ha || hb;
        this.handMeshes[i].position.fromArray(h.p);
        this.handMeshes[i].quaternion.fromArray(h.q);
      }
    }
  }

  dispose() {
    this.scene.remove(this.headMesh);
    this.scene.remove(this.handGroup);
    // Materials are cloned per avatar so safe to dispose
    this.headMesh.material.dispose();
    this.handMeshes.forEach((m) => m.material.dispose());
    this.label.material.map.dispose();
    this.label.material.dispose();
  }
}

// Reusable temporaries
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _qa  = new THREE.Quaternion();
const _qb  = new THREE.Quaternion();

// ── Manager ───────────────────────────────────────────────────────────────────

export function setupPeerAvatars(scene) {
  const peers = new Map(); // identity → PeerAvatar

  onPeerJoin((identity, displayName) => {
    if (peers.has(identity)) return;
    peers.set(identity, new PeerAvatar(identity, displayName, scene));
  });

  onPeerLeave((identity) => {
    const av = peers.get(identity);
    if (av) { av.dispose(); peers.delete(identity); }
  });

  onPeerPose((msg, identity, displayName) => {
    if (!peers.has(identity)) {
      peers.set(identity, new PeerAvatar(identity, displayName, scene));
    }
    peers.get(identity).pushPose(msg);
  });

  function updatePeers(_delta) {
    const now = performance.now() / 1000;
    for (const av of peers.values()) av.update(now);
  }

  return { updatePeers };
}
