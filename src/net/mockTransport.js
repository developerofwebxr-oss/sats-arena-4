/**
 * mockTransport.js — local transports for credential-free testing.
 *
 * Exports:
 *   MockTransport   — synthetic bot peer + impairment simulator (?net=mock)
 *   BCTransport     — BroadcastChannel cross-tab real presence (?net=bc)
 *
 * Neither sends anything over the network. Both satisfy the same interface as
 * LiveKitTransport: join / leave / sendPose / tick / getParticipantCount / getRoomName.
 *
 * Bot lifecycle (MockTransport):
 *   join()         → bot joins ~1s later, starts emitting 15 Hz poses
 *   leave()        → bot sends clean leave (fires onPeerLeave)
 *   silentDeath()  → bot stops emitting, NO leave event (trips staleness timeout)
 *   reconnect()    → bot re-joins; dedupes by same identity (no duplicate avatar)
 *   toggleMode()   → switch bot between 'vr' (2 hands) and 'flat' (aim marker)
 *   setSpeaking()  → toggle bot speaking indicator on/off
 *
 * Impairment simulator (both transports, inbound path only):
 *   setLatency(ms) / setJitter(ms) / setLoss(0-1) / setReorder(0-1)
 *   Outgoing sendPose() is accepted and silently discarded.
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Quaternion from a pure Y-axis yaw rotation (Three.js convention: -Z forward). */
function yawQ(yaw) {
  const h = yaw / 2;
  return [0, Math.sin(h), 0, Math.cos(h)];
}

/**
 * Compute synthetic bot pose at time t (seconds).
 * Patrol: slow circle radius 3m, period 20s.
 * Head: faces travel direction + ±45° sweep over 4s.
 * VR mode: 2 controller hands; flat mode: 1 aim marker.
 */
function botPose(t, mode) {
  const R  = 3.0;
  const θ  = (t / 20) * 2 * Math.PI;

  const px = R * Math.sin(θ);
  const pz = R * Math.cos(θ);
  const py = 1.65;

  // Travel direction tangent to circle: d/dθ (sin θ, cos θ) = (cos θ, -sin θ).
  // To look in (cos θ, 0, -sin θ) with Three.js yaw (−Z forward):
  //   −sin(yaw) = cos θ  →  yaw = −asin(cos θ) = atan2(−cos θ, sin θ)
  const travelYaw = Math.atan2(-Math.cos(θ), Math.sin(θ));
  const sweep     = Math.sin(t * (2 * Math.PI / 4)) * (Math.PI / 4);
  const headYaw   = travelYaw + sweep;

  const head = { p: [px, py, pz], q: yawQ(headYaw) };

  // Right vector from headYaw: right = (cos headYaw, 0, −sin headYaw)
  const rx = Math.cos(headYaw);
  const rz = -Math.sin(headYaw);

  if (mode === 'flat') {
    // Aim marker 1 m in front of head (−Z forward → −sin headYaw, −cos headYaw)
    const aim = {
      p: [px - Math.sin(headYaw), py, pz - Math.cos(headYaw)],
      q: yawQ(headYaw),
    };
    return { head, hands: [aim] };
  }

  // VR: 2 hands, subtle alternating bob
  const bob = Math.sin(t * (2 * Math.PI / 1.2)) * 0.04;
  const leftHand  = { p: [px - rx * 0.35, py - 0.3 + bob,  pz - rz * 0.35], q: yawQ(headYaw - 0.25) };
  const rightHand = { p: [px + rx * 0.35, py - 0.3 - bob,  pz + rz * 0.35], q: yawQ(headYaw + 0.25) };
  return { head, hands: [leftHand, rightHand] };
}

// ── ImpairmentSim ─────────────────────────────────────────────────────────────

class ImpairmentSim {
  constructor() {
    this.latency = 100;  // ms base delay
    this.jitter  = 40;   // ms ± per packet
    this.loss    = 0.04; // drop probability [0,1]
    this.reorder = 0.05; // extra-delay probability [0,1]
    this._queue  = [];   // { at: ms, deliver: fn }
  }

  /** Schedule one packet for delivery through the impairment pipeline. */
  push(deliver) {
    if (Math.random() < this.loss) {
      console.log('[imp] drop (loss)');
      return;
    }
    let delay = this.latency + (Math.random() * 2 - 1) * this.jitter;
    if (Math.random() < this.reorder) {
      delay += 50 + Math.random() * 100;
      console.log('[imp] reorder extra-delay');
    }
    this._queue.push({ at: performance.now() + Math.max(0, delay), deliver });
  }

  /** Flush all packets whose scheduled delivery time has passed. */
  tick() {
    if (this._queue.length === 0) return;
    const now   = performance.now();
    const ready = [];
    const hold  = [];
    for (const item of this._queue) {
      (item.at <= now ? ready : hold).push(item);
    }
    this._queue = hold;
    // Deliver in scheduled-arrival order so normal packets stay ordered;
    // reordered packets naturally arrive late → stale-packet guard drops them.
    ready.sort((a, b) => a.at - b.at);
    for (const item of ready) item.deliver();
  }
}

// ── MockTransport ─────────────────────────────────────────────────────────────

const BOT_ID   = 'bot-1';
const BOT_NAME = 'Bot';
const BOT_HZ   = 15;

export class MockTransport {
  constructor(callbacks) {
    this._cb  = callbacks;
    this._imp = new ImpairmentSim();

    this._roomName = null;
    this._joined   = false;  // have we called transport.join()?
    this._botAlive = false;  // bot is emitting poses
    this._botSeen  = false;  // peer-avatars was told bot joined
    this._botMode  = 'vr';
    this._speaking = false;

    this._t           = 0;   // bot clock (seconds)
    this._seq         = 0;
    this._speakTimer  = 3 + Math.random() * 4;
    this._speakOn     = false;

    this._rafId = null;
    this._lastTs = null;
  }

  // ── Transport interface ───────────────────────────────────────────────────

  async join(roomName, _identity) {
    this._roomName = roomName;
    this._joined   = true;
    console.log(`[room:mock] joined "${roomName}"`);
    // Bot appears ~1s after joining.
    setTimeout(() => this._botJoin(), 1000);
  }

  async leave() {
    if (this._botAlive) this._botLeave();
    this._joined   = false;
    this._roomName = null;
  }

  // Outgoing poses/events accepted and discarded (local player only visible to self).
  sendPose(_pose)  {}
  sendEvent(_evt)  {}

  setMicEnabled(_enabled) {}

  getParticipantCount() { return this._joined ? (this._botSeen ? 2 : 1) : 0; }
  getRoomName()         { return this._roomName; }

  /**
   * Must be called every animation frame (from tickTransport() in room.js).
   * Advances the bot clock, emits poses, and flushes the impairment queue.
   */
  tick() {
    const now = performance.now();
    const dt  = this._lastTs === null ? 0 : (now - this._lastTs) / 1000;
    this._lastTs = now;

    if (this._botAlive) {
      this._t += dt;

      // Speaking toggle
      this._speakTimer -= dt;
      if (this._speakTimer <= 0) {
        this._speakOn    = !this._speakOn;
        this._speakTimer = this._speakOn ? (1 + Math.random() * 2.5) : (2 + Math.random() * 4);
      }

      // Emit one pose per bot tick at BOT_HZ
      this._botElapsed = (this._botElapsed || 0) + dt;
      if (this._botElapsed >= 1 / BOT_HZ) {
        this._botElapsed -= 1 / BOT_HZ;
        this._emitBotPose();
      }
    }

    this._imp.tick();
  }

  // ── Bot lifecycle (callable from dev panel) ───────────────────────────────

  /** Announce bot joining. Safe to call multiple times — dedupes by identity. */
  _botJoin() {
    if (!this._botSeen) {
      this._botSeen = true;
      this._cb.onPeerJoin(BOT_ID, BOT_NAME);
    }
    this._botAlive    = true;
    this._t           = 0;
    this._botElapsed  = 0;
    this._speakOn     = false;
    this._speakTimer  = 3 + Math.random() * 4;
    console.log('[room:mock] bot joined');
  }

  /** Clean leave — fires onPeerLeave so the avatar is removed immediately. */
  _botLeave() {
    this._botAlive = false;
    if (this._botSeen) {
      this._botSeen = false;
      this._cb.onPeerLeave(BOT_ID);
    }
    console.log('[room:mock] bot left (clean)');
  }

  /** Silent death — stops poses, NO leave event → trips staleness timeout. */
  _botSilentDeath() {
    this._botAlive = false;
    console.log('[room:mock] bot silent death (staleness test)');
  }

  /** Re-join after leave or silent death; dedupes so no duplicate avatar. */
  _botReconnect() {
    this._botJoin();
    console.log('[room:mock] bot reconnected');
  }

  _emitBotPose() {
    const seq  = ++this._seq;
    const pose = botPose(this._t, this._botMode);
    const msg  = { t: 'pose', seq, mode: this._botMode, speaking: this._speakOn, ...pose };
    this._imp.push(() => {
      this._cb.onPeerPose(msg, BOT_ID, BOT_NAME);
    });
  }

  // ── Dev controls (returned to mock-dev-panel.js) ─────────────────────────

  getDevControls() {
    const imp = this._imp;
    return {
      // Impairment
      setLatency: (ms)  => { imp.latency = ms;   },
      setJitter:  (ms)  => { imp.jitter  = ms;   },
      setLoss:    (v)   => { imp.loss    = v;     },
      setReorder: (v)   => { imp.reorder = v;     },
      getImpairment: () => ({
        latency: imp.latency, jitter: imp.jitter,
        loss: imp.loss,       reorder: imp.reorder,
      }),
      // Bot lifecycle
      botJoin:        () => this._botJoin(),
      botLeave:       () => this._botLeave(),
      botSilentDeath: () => this._botSilentDeath(),
      botReconnect:   () => this._botReconnect(),
      // Bot visual
      toggleBotMode:  () => {
        this._botMode = this._botMode === 'vr' ? 'flat' : 'vr';
        return this._botMode;
      },
      getBotMode:     () => this._botMode,
      setSpeaking:    (v) => { this._speakOn = v; },
      isSpeaking:     () => this._speakOn,
    };
  }
}

// ── BCTransport ───────────────────────────────────────────────────────────────

export class BCTransport {
  constructor(callbacks) {
    this._cb       = callbacks;
    this._imp      = new ImpairmentSim();
    this._channel  = null;
    this._roomName = null;
    this._identity = null;
    this._peers    = new Map(); // identity → displayName
    this._replied  = new Set(); // identities we've already replied to with a join
  }

  async join(roomName, identity) {
    if (this._channel) await this.leave();
    this._roomName = roomName;
    this._identity = identity;

    this._channel = new BroadcastChannel(`sats-arena-4-${roomName}`);
    this._channel.addEventListener('message', (ev) => this._onMessage(ev));

    // Announce ourselves; existing tabs will reply with their own join.
    this._channel.postMessage({ t: 'join', identity, displayName: identity });
    console.log(`[room:bc] joined "${roomName}" as ${identity}`);
  }

  async leave() {
    if (!this._channel) return;
    this._channel.postMessage({ t: 'leave', identity: this._identity });
    this._channel.close();
    this._channel  = null;
    this._roomName = null;
    this._identity = null;
    this._peers.clear();
    this._replied.clear();
  }

  sendPose(pose) {
    if (!this._channel) return;
    const msg = { t: 'pose', identity: this._identity, displayName: this._identity, pose };
    this._channel.postMessage(msg);
  }

  sendEvent(evt) {
    if (!this._channel) return;
    this._channel.postMessage({ ...evt, identity: this._identity, displayName: this._identity });
  }

  setMicEnabled(_e) {}

  getParticipantCount() { return this._peers.size + (this._channel ? 1 : 0); }
  getRoomName()         { return this._roomName; }

  tick() { this._imp.tick(); }

  _onMessage(ev) {
    const msg = ev.data;
    if (!msg || msg.identity === this._identity) return;

    const id   = msg.identity;
    const name = msg.displayName || id;

    if (msg.t === 'join') {
      if (!this._peers.has(id)) {
        this._peers.set(id, name);
        this._cb.onPeerJoin(id, name);
      }
      // Reply once so late-joiners know about us.
      if (!this._replied.has(id)) {
        this._replied.add(id);
        this._channel.postMessage({ t: 'join', identity: this._identity, displayName: this._identity });
      }
    } else if (msg.t === 'leave') {
      this._peers.delete(id);
      this._replied.delete(id);
      this._cb.onPeerLeave(id);
    } else if (msg.t === 'pose') {
      if (!this._peers.has(id)) {
        // First pose from a peer we haven't formally met — add them.
        this._peers.set(id, name);
        this._cb.onPeerJoin(id, name);
        if (!this._replied.has(id)) {
          this._replied.add(id);
          this._channel.postMessage({ t: 'join', identity: this._identity, displayName: this._identity });
        }
      }
      const pose = msg.pose;
      this._imp.push(() => this._cb.onPeerPose(pose, id, name));
    } else if (msg.t === 'shot') {
      this._cb.onPeerEvent(msg, id, name);
    }
  }

  getDevControls() {
    const imp = this._imp;
    return {
      setLatency: (ms) => { imp.latency = ms;  },
      setJitter:  (ms) => { imp.jitter  = ms;  },
      setLoss:    (v)  => { imp.loss    = v;   },
      setReorder: (v)  => { imp.reorder = v;   },
      getImpairment: () => ({
        latency: imp.latency, jitter: imp.jitter,
        loss: imp.loss,       reorder: imp.reorder,
      }),
    };
  }
}
