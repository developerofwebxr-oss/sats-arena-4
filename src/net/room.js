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

import { Room, RoomEvent, Track } from 'livekit-client';
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

class LiveKitTransport {
  constructor() {
    this._room = null;
    // Audio elements we created for remote voice tracks, so leave() can sweep
    // any that TrackUnsubscribed didn't already clean up.
    this._audioEls = new Set();
  }

  // ── Remote voice playback ───────────────────────────────────────────────────
  // A subscribed audio track produces NO sound until it is attached to a media
  // element that is in the document. livekit-client does not do this for you:
  // `attachedElements` is only ever populated by Track.attach(), and the
  // element-free Web Audio path (webAudioMix) is off by default. So without the
  // two handlers below, peers are subscribed (and consuming bandwidth) but
  // silent on every platform.
  _wireRemoteAudio(room) {
    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      // attach() creates a fresh <audio autoplay> wired to this track.
      const el = track.attach();
      el.dataset.peer = participant?.identity || '';
      _audioSink().appendChild(el);
      this._audioEls.add(el);
      console.log(`[room:lk] voice attached from ${el.dataset.peer}`);

      // TODO(Batch 2): mobile/Safari autoplay policy will reject el.play() until
      // the page has had a user gesture. Handle RoomEvent.AudioPlaybackStatusChanged
      // and call room.startAudio() from a gesture to recover. Not wired here on
      // purpose — Batch 1 is the attach/publish pipeline only.
    });

    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      if (track.kind !== Track.Kind.Audio) return;
      // detach() with no argument detaches ALL elements and returns them.
      for (const el of track.detach()) {
        el.remove();
        this._audioEls.delete(el);
      }
    });
  }

  // Mirror the REAL local mic state out to the UI whenever LiveKit changes it,
  // so no view has to keep its own boolean in sync (that inversion is exactly
  // what made the mute button lie).
  _wireMicState(room) {
    const emit = () => _cb.onMicState(room.localParticipant.isMicrophoneEnabled);
    room.on(RoomEvent.LocalTrackPublished,   emit);
    room.on(RoomEvent.LocalTrackUnpublished, emit);
    room.on(RoomEvent.TrackMuted,            emit);
    room.on(RoomEvent.TrackUnmuted,          emit);
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

    this._wireRemoteAudio(room); // remote voice → <audio> elements (must precede connect)
    this._wireMicState(room);    // real local mic state → UI

    // autoSubscribe pulls peer audio down; _wireRemoteAudio is what makes it audible.
    // NOTE: the mic is deliberately NOT published here — players join MUTED and
    // opt in via the mute control (no hot mic, no permission prompt at load).
    await room.connect(LK_URL, token, { autoSubscribe: true });
    this._room = room;
    console.log(`[room:lk] joined "${roomName}" as ${identity}`);
  }

  async leave() {
    if (!this._room) return;
    await this._room.disconnect();
    // disconnect() normally fires TrackUnsubscribed for each track, but sweep
    // anything left so a rejoin can't accumulate orphaned <audio> elements.
    for (const el of this._audioEls) el.remove();
    this._audioEls.clear();
    this._room = null;
    _cb.onMicState(false); // no room → definitively not transmitting
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
    // setMicrophoneEnabled(true) is what triggers getUserMedia — it must stay on
    // a user-gesture path (the mute button) so the permission prompt is allowed.
    await this._room.localParticipant.setMicrophoneEnabled(enabled);
  }

  // The single source of truth for "am I actually transmitting right now".
  // false when the mic is unpublished OR published-but-muted.
  isMicEnabled() {
    return this._room?.localParticipant?.isMicrophoneEnabled ?? false;
  }

  getParticipantCount() { return this._room?.numParticipants ?? 0; }
  getRoomName()         { return this._room?.name ?? null; }
  tick()                {}
}

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
