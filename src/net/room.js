/**
 * room.js — clean networking seam for co-op presence.
 *
 * Public API (UNCHANGED across all transports):
 *   joinSession(code, { name, mode })  → Promise<void>
 *   leaveSession()
 *   sendPose(pose)                      lossy, ~15 Hz
 *   onPeerPose(cb)
 *   onPeerJoin(cb)
 *   onPeerLeave(cb)
 *   setMicEnabled(bool)
 *   getParticipantCount()               includes local
 *   getRoomName()
 *   tickTransport()                     call each animation frame
 *   getActiveTransportType()            'mock' | 'bc' | 'livekit'
 *   getActiveTransport()                transport instance (for dev panels)
 *
 * Transport selection (first match wins):
 *   ?net=live  → force LiveKit (requires VITE_LIVEKIT_URL)
 *   ?net=bc    → BroadcastChannel (2 real tabs, same machine)
 *   ?net=mock  → MockTransport
 *   (none)     → LiveKit when VITE_LIVEKIT_URL is set, else MockTransport
 */

import { Room, RoomEvent } from 'livekit-client';
import { MockTransport, BCTransport } from './mockTransport.js';

// Normalize: add https:// if the env var was set without a protocol prefix
// (e.g. "sats-arena-4-production.up.railway.app" → relative URL → 405 on Pages).
function _normalizeBackend(raw) {
  if (!raw) return '';
  const s = raw.replace(/\/+$/, '');
  return s.startsWith('http') ? s : `https://${s}`;
}
const BACKEND = _normalizeBackend(import.meta.env.VITE_BACKEND_URL);
const LK_URL  = import.meta.env.VITE_LIVEKIT_URL || '';

// ── Transport selection ───────────────────────────────────────────────────────

function pickTransportType() {
  const p = new URLSearchParams(location.search).get('net');
  if (p === 'live' && LK_URL) return 'livekit';
  if (p === 'bc')             return 'bc';
  if (p === 'mock')           return 'mock';
  return LK_URL ? 'livekit' : 'mock';
}

const ACTIVE_TYPE = pickTransportType();
console.log(`[room] transport: ${ACTIVE_TYPE}`);

// ── Subscriber lists — multiple modules can register without overwriting each other ─

const _poseCbs  = [];
const _joinCbs  = [];
const _leaveCbs = [];
const _eventCbs = [];

const _cb = {
  onPeerPose:  (msg, id, name) => _poseCbs.forEach(cb => cb(msg, id, name)),
  onPeerJoin:  (id, name)      => _joinCbs.forEach(cb => cb(id, name)),
  onPeerLeave: (id)            => _leaveCbs.forEach(cb => cb(id)),
  onPeerEvent: (msg, id, name) => _eventCbs.forEach(cb => cb(msg, id, name)),
};

// ── LiveKit transport ─────────────────────────────────────────────────────────

class LiveKitTransport {
  constructor() {
    this._room = null;
  }

  async join(roomName, identity, { ownerToken, admissionTicket } = {}) {
    if (this._room) await this.leave();
    if (!LK_URL) throw new Error('VITE_LIVEKIT_URL is not set. Add it to .env.local.');

    const token = await _fetchLKToken(roomName, identity, ownerToken, admissionTicket);
    const room  = new Room({ adaptiveStream: true, dynacast: true });

    room.on(RoomEvent.DataReceived, (payload, participant) => {
      if (!participant) return;
      let msg;
      try { msg = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
      const pid = participant.identity, pname = participant.name || participant.identity;
      if (msg.t === 'pose') _cb.onPeerPose(msg, pid, pname);
      else                  _cb.onPeerEvent(msg, pid, pname);
    });

    room.on(RoomEvent.ParticipantConnected,    (p) => _cb.onPeerJoin(p.identity, p.name || p.identity));
    room.on(RoomEvent.ParticipantDisconnected, (p) => _cb.onPeerLeave(p.identity));

    await room.connect(LK_URL, token, { autoSubscribe: true });
    this._room = room;
    console.log(`[room:lk] joined "${roomName}" as ${identity}`);
  }

  async leave() {
    if (!this._room) return;
    await this._room.disconnect();
    this._room = null;
  }

  sendPose(pose) {
    if (!this._room || this._room.state !== 'connected') return;
    const data = _enc.encode(JSON.stringify({ t: 'pose', ...pose }));
    this._room.localParticipant.publishData(data, { reliable: false });
  }

  sendEvent(evt, { reliable = false } = {}) {
    if (!this._room || this._room.state !== 'connected') return;
    const data = _enc.encode(JSON.stringify(evt));
    this._room.localParticipant.publishData(data, { reliable });
  }

  async setMicEnabled(enabled) {
    if (!this._room) return;
    await this._room.localParticipant.setMicrophoneEnabled(enabled);
  }

  getParticipantCount() { return this._room?.numParticipants ?? 0; }
  getRoomName()         { return this._room?.name ?? null; }
  tick()                {}
}

const _enc = new TextEncoder();

async function _fetchLKToken(roomName, identity, ownerToken, admissionTicket) {
  const base = (import.meta.env.VITE_TOKEN_URL || BACKEND).replace(/\/+$/, '');
  const res  = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: roomName, identity, ownerToken, admissionTicket }),
  });
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status} ${await res.text()}`);
  const { token } = await res.json();
  return token;
}

// ── Active transport instance ─────────────────────────────────────────────────
// Mock/BC are created eagerly so the dev panel can wire up before the first join.
// LiveKit is created lazily (needs credentials only at join time).

let _transport = ACTIVE_TYPE === 'bc'
  ? new BCTransport(_cb)
  : ACTIVE_TYPE === 'mock'
    ? new MockTransport(_cb)
    : null;

// ── Public API ────────────────────────────────────────────────────────────────

export async function joinSession(code, { name = 'Player', mode = 'flat', ownerToken, admissionTicket } = {}) {
  if (!_transport) _transport = new LiveKitTransport();
  const identity = `${name.replace(/\s+/g, '-').slice(0, 20)}-${Date.now().toString(36)}`;
  await _transport.join(String(code), identity, { ownerToken, admissionTicket });
}

export async function leaveSession() {
  await _transport?.leave();
}

export function sendPose(pose)  { _transport?.sendPose(pose); }
// opts.reliable = true → guaranteed-delivery channel (control + score messages).
export function sendEvent(evt, opts)  { _transport?.sendEvent?.(evt, opts); }

export function onPeerPose(cb)   { _poseCbs.push(cb);  }
export function onPeerJoin(cb)   { _joinCbs.push(cb);  }
export function onPeerLeave(cb)  { _leaveCbs.push(cb); }
export function onPeerEvent(cb)  { _eventCbs.push(cb); }

export async function setMicEnabled(enabled) {
  await _transport?.setMicEnabled?.(enabled);
}

export function getParticipantCount() { return _transport?.getParticipantCount?.() ?? 0; }
export function getRoomName()         { return _transport?.getRoomName?.()         ?? null; }

// Must be called each animation frame — mock/BC flush impairment queues here.
export function tickTransport() { _transport?.tick?.(); }

export function getActiveTransportType() { return ACTIVE_TYPE; }
export function getActiveTransport()     { return _transport; }

// Dev global — exposes live transport via window to sidestep Vite HMR
// module-split (tickTransport() in main.js may hold an old closure after HMR;
// reading through this global always hits the current _transport).
if (import.meta.env.DEV) {
  window.__satsArenaNet = {
    get transport() { return _transport; },
    get type()      { return ACTIVE_TYPE; },
    tick:           () => tickTransport(),
  };
  // Decline HMR for this file — it holds singleton transport state and
  // partial re-evaluation causes a module split with stale closures.
  // Vite will trigger a full page reload instead.
  import.meta.hot?.decline();
}
