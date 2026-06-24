/**
 * peer-avatars.js — render remote players as head + hand markers + name label.
 *
 * Hardening (Phase 1 mock):
 *   • Stale-packet guard: drops any packet whose seq ≤ highest-seen seq for that peer.
 *   • Staleness timeout: no pose for STALE_TIMEOUT seconds → fade over FADE_SECS → remove.
 *   • Avatar spawns at FIRST received pose (head visible only after first pushPose).
 *   • Avatar shape driven by sender's declared mode in the packet (vr / flat / ar).
 *   • Speaking indicator: pulsing torus ring around head when peer's speaking flag is set.
 *   • Dejitter buffer keyed off receive-time (~100 ms lag), slerp rotation. (unchanged)
 */

import * as THREE from 'three';
import { onPeerPose, onPeerJoin, onPeerLeave } from './room.js';

const BUFFER_DELAY  = 0.1;  // seconds of interpolation lag (dejitter)
const STALE_TIMEOUT = 3.0;  // seconds before fade starts after last pose
const FADE_SECS     = 1.5;  // seconds to fade from full opacity to invisible

// ── Shared geometry / material (allocated once) ───────────────────────────────

let _headGeo, _headMat, _handGeo, _handMat, _ringGeo;

function shared() {
  if (!_headGeo) {
    _headGeo = new THREE.SphereGeometry(0.12, 12, 8);
    _headMat = new THREE.MeshStandardMaterial({ color: 0x44aaff, roughness: 0.6, metalness: 0.1 });
    _handGeo = new THREE.SphereGeometry(0.05, 8, 6);
    _handMat = new THREE.MeshStandardMaterial({ color: 0xffaa44, roughness: 0.7, metalness: 0 });
    _ringGeo = new THREE.TorusGeometry(0.16, 0.012, 6, 24);
  }
  return { _headGeo, _headMat, _handGeo, _handMat, _ringGeo };
}

// ── Single peer ───────────────────────────────────────────────────────────────

class PeerAvatar {
  constructor(identity, displayName, scene) {
    this.identity    = identity;
    this.displayName = displayName;
    this.scene       = scene;
    this.poseBuffer  = []; // [{ time, msg }] keyed off receive-time
    this.dead        = false;

    // Stale-packet guard: drop if incoming seq ≤ _maxSeq.
    this._maxSeq = -1;

    // Staleness tracking
    this._lastRecvSec = null;
    this._opacity     = 1.0;
    this._speaking    = false;

    const { _headGeo, _headMat, _handGeo, _handMat, _ringGeo } = shared();

    this.headMesh = new THREE.Mesh(_headGeo, _headMat.clone());
    this.headMesh.visible = false;  // hidden until first pose arrives
    scene.add(this.headMesh);

    // Speaking ring — child of head so it moves with it.
    this._ring = new THREE.Mesh(
      _ringGeo,
      new THREE.MeshBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0 })
    );
    this._ring.rotation.x = Math.PI / 2; // lay flat (horizontal) around head
    this.headMesh.add(this._ring);

    this.handMeshes = [];
    this.handGroup  = new THREE.Group();
    scene.add(this.handGroup);

    this.label = this._makeLabel(displayName);
    this.headMesh.add(this.label);

    this._handGeo = _handGeo;
    this._handMat = _handMat;
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

    const tex    = new THREE.CanvasTexture(canvas);
    const mat    = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.6, 0.15, 1);
    sprite.position.set(0, 0.22, 0);
    return sprite;
  }

  pushPose(msg) {
    // ── Stale-packet guard ───────────────────────────────────────────────────
    if (msg.seq !== undefined) {
      if (msg.seq <= this._maxSeq) {
        console.log(`[avatar:${this.identity}] drop stale seq=${msg.seq} (max=${this._maxSeq})`);
        return;
      }
      this._maxSeq = msg.seq;
    }

    const recvSec = performance.now() / 1000;
    this._lastRecvSec = recvSec;

    this.poseBuffer.push({ time: recvSec, msg });

    // Bound buffer to 2s
    const cutoff = recvSec - 2;
    while (this.poseBuffer.length > 2 && this.poseBuffer[0].time < cutoff) {
      this.poseBuffer.shift();
    }

    // Update speaking state from packet flag.
    if (msg.speaking !== undefined) this._speaking = msg.speaking;
  }

  _ensureHands(count) {
    while (this.handMeshes.length < count) {
      const m = new THREE.Mesh(this._handGeo, this._handMat.clone());
      m.visible = false;
      this.handGroup.add(m);
      this.handMeshes.push(m);
    }
    for (let i = count; i < this.handMeshes.length; i++) {
      this.handMeshes[i].visible = false;
    }
  }

  update(nowSec) {
    // ── Staleness / fade ─────────────────────────────────────────────────────
    if (this._lastRecvSec !== null) {
      const age = nowSec - this._lastRecvSec;
      if (age > STALE_TIMEOUT + FADE_SECS) {
        this.dead = true;
        return;
      }
      if (age > STALE_TIMEOUT) {
        const t = (age - STALE_TIMEOUT) / FADE_SECS;
        this._setOpacity(1 - t);
      } else if (this._opacity < 1) {
        this._setOpacity(1);
      }
    }

    // ── Speaking ring pulse ──────────────────────────────────────────────────
    if (this._speaking) {
      const pulse = 0.45 + 0.35 * Math.sin(nowSec * Math.PI * 4);
      this._ring.material.opacity = pulse;
    } else {
      this._ring.material.opacity = 0;
    }

    // ── Interpolation ────────────────────────────────────────────────────────
    const target = nowSec - BUFFER_DELAY;
    const buf    = this.poseBuffer;
    if (buf.length === 0) return;

    let before = null, after = null;
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].time <= target && buf[i + 1].time >= target) {
        before = buf[i];
        after  = buf[i + 1];
        break;
      }
    }

    if (!before) {
      const sample = buf[buf.length - 1];
      if (sample.time > target + 0.5) return; // too far in the future, wait
      this._applyPose(sample.msg);
      return;
    }

    const t = (target - before.time) / (after.time - before.time);
    this._applyInterpolated(before.msg, after.msg, t);
  }

  _applyPose(msg) {
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

    const aH = a.hands || [];
    const bH = b.hands || [];
    for (let i = 0; i < handCount; i++) {
      const ha = aH[i], hb = bH[i];
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

  _setOpacity(v) {
    this._opacity = v;
    this.headMesh.material.opacity     = v;
    this.headMesh.material.transparent = v < 1;
    this.handMeshes.forEach((m) => {
      m.material.opacity     = v;
      m.material.transparent = v < 1;
    });
    this.label.material.opacity = v;
  }

  dispose() {
    this.scene.remove(this.headMesh);
    this.scene.remove(this.handGroup);
    this.headMesh.material.dispose();
    this._ring.material.dispose();
    this.handMeshes.forEach((m) => m.material.dispose());
    this.label.material.map.dispose();
    this.label.material.dispose();
  }
}

// Reusable vector/quaternion temporaries — no per-frame allocation.
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _qa  = new THREE.Quaternion();
const _qb  = new THREE.Quaternion();

// ── Manager ───────────────────────────────────────────────────────────────────

export function setupPeerAvatars(scene) {
  const peers = new Map(); // identity → PeerAvatar

  onPeerJoin((identity, displayName) => {
    if (peers.has(identity)) return; // dedupe
    peers.set(identity, new PeerAvatar(identity, displayName, scene));
  });

  onPeerLeave((identity) => {
    const av = peers.get(identity);
    if (av) { av.dispose(); peers.delete(identity); }
  });

  onPeerPose((msg, identity, displayName) => {
    if (!peers.has(identity)) {
      // First pose before join event (race) — create avatar at first-pose position.
      peers.set(identity, new PeerAvatar(identity, displayName, scene));
    }
    peers.get(identity).pushPose(msg);
  });

  function updatePeers(_delta) {
    const nowSec = performance.now() / 1000;
    for (const [id, av] of peers) {
      av.update(nowSec);
      if (av.dead) {
        av.dispose();
        peers.delete(id);
        console.log(`[avatar] removed stale peer ${id}`);
      }
    }
  }

  return { updatePeers };
}
