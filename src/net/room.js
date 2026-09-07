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
 *   setMicEnabled(bool)                 publish/unpublish the mic
 *   isMicEnabled()                      REAL publish state (not a local guess)
 *   onMicStateChange(cb)                fires when the real state changes
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
const _micCbs   = [];

const _cb = {
  onPeerPose:  (msg, id, name) => _poseCbs.forEach(cb => cb(msg, id, name)),
  onPeerJoin:  (id, name)      => _joinCbs.forEach(cb => cb(id, name)),
  onPeerLeave: (id)            => _leaveCbs.forEach(cb => cb(id)),
  onPeerEvent: (msg, id, name) => _eventCbs.forEach(cb => cb(msg, id, name)),
  // Real local-mic publish state changed (published/unpublished/muted/unmuted).
  onMicState:  (enabled)       => _micCbs.forEach(cb => cb(enabled)),
};

// ── LiveKit transport ─────────────────────────────────────────────────────────
// The implementation moved to ./livekit-transport.js and is import()ed on demand
// in joinSession() — see that file's header. livekit-client was 42% of the
// initial bundle and is not needed to render a single frame.

const _enc = new TextEncoder();

// ── Audio sink ────────────────────────────────────────────────────────────────
// Remote voice elements must be IN the document to play reliably. They render
// nothing (no controls), so the container is inert — it just has to exist.
let _sink = null;
function _audioSink() {
  if (!_sink) {
    _sink = document.createElement('div');
    _sink.id = 'lk-audio-sink';
    _sink.style.display = 'none';
    document.body.appendChild(_sink);
  }
  return _sink;
}

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
  if (!_transport) {
    // Loads livekit-client (508 KB) here, on the join, instead of at boot.
    const { LiveKitTransport } = await import('./livekit-transport.js');
    _transport = new LiveKitTransport({
      cb: _cb, lkUrl: LK_URL, fetchToken: _fetchLKToken, audioSink: _audioSink,
    });
  }
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

// Publish (true) or unpublish (false) the local mic. Call from a user gesture:
// the first `true` is what prompts for microphone permission.
// TODO(Batch 2): pre-warm this permission on the FLAT page before entering
// VR/AR — Quest Browser cannot show a permission prompt inside an immersive
// session, so a headset user can never grant it from the in-world menu.
export async function setMicEnabled(enabled) {
  await _transport?.setMicEnabled?.(enabled);
}

/** REAL mic publish state. false when unpublished OR muted. Never a local guess. */
export function isMicEnabled() {
  return _transport?.isMicEnabled?.() ?? false;
}

/** Subscribe to real mic-state changes. Fires immediately with current state. */
export function onMicStateChange(cb) {
  _micCbs.push(cb);
  cb(isMicEnabled());
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
