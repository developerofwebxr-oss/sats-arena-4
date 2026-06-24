/**
 * room.js — clean networking seam for co-op presence.
 *
 * All LiveKit calls go through here. Later phases add sendReliable / onReliable
 * for shared game state without rewiring anything else.
 *
 * Public API:
 *   joinSession(code, { name, mode })  → Promise<void>
 *   leaveSession()
 *   sendPose(pose)                      lossy, ~15 Hz
 *   onPeerPose(cb)
 *   onPeerJoin(cb)
 *   onPeerLeave(cb)
 *   setMicEnabled(bool)
 *   getParticipantCount()              includes local
 */

import { Room, RoomEvent } from 'livekit-client';

const BACKEND = (import.meta.env.VITE_BACKEND_URL || '').replace(/\/+$/, '');
const LK_URL  = import.meta.env.VITE_LIVEKIT_URL || '';

let room = null;
let _onPeerPose  = () => {};
let _onPeerJoin  = () => {};
let _onPeerLeave = () => {};

// ── Token fetch ──────────────────────────────────────────────────────────────

async function fetchToken(roomName, identity) {
  const base = (import.meta.env.VITE_TOKEN_URL || BACKEND).replace(/\/+$/, '');
  const res = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: roomName, identity }),
  });
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status} ${await res.text()}`);
  const { token } = await res.json();
  return token;
}

// ── Join / leave ─────────────────────────────────────────────────────────────

export async function joinSession(code, { name = 'Player', mode = 'flat' } = {}) {
  if (room) await leaveSession();

  if (!LK_URL) throw new Error('VITE_LIVEKIT_URL is not set. Add it to .env.local.');

  const identity = `${name.replace(/\s+/g, '-').slice(0, 20)}-${Date.now().toString(36)}`;
  const token = await fetchToken(String(code), identity);

  room = new Room({ adaptiveStream: true, dynacast: true });

  room.on(RoomEvent.DataReceived, (payload, participant) => {
    if (!participant) return;
    let msg;
    try { msg = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
    if (msg.t === 'pose') _onPeerPose(msg, participant.identity, participant.name || participant.identity);
  });

  room.on(RoomEvent.ParticipantConnected, (p) => {
    _onPeerJoin(p.identity, p.name || p.identity);
  });

  room.on(RoomEvent.ParticipantDisconnected, (p) => {
    _onPeerLeave(p.identity);
  });

  await room.connect(LK_URL, token, { autoSubscribe: true });
  console.log(`[room] joined "${code}" as ${identity}`);
}

export async function leaveSession() {
  if (!room) return;
  await room.disconnect();
  room = null;
}

// ── Pose (lossy) ─────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

export function sendPose(pose) {
  if (!room || room.state !== 'connected') return;
  const data = encoder.encode(JSON.stringify({ t: 'pose', ...pose }));
  room.localParticipant.publishData(data, { reliable: false });
}

// ── Callbacks ─────────────────────────────────────────────────────────────────
// Shape: { head: {p,q}, hands: [{p,q}, ...], mode }

export function onPeerPose(cb)  { _onPeerPose  = cb; }
export function onPeerJoin(cb)  { _onPeerJoin  = cb; }
export function onPeerLeave(cb) { _onPeerLeave = cb; }

// ── Voice ─────────────────────────────────────────────────────────────────────

let micTrack = null;

export async function setMicEnabled(enabled) {
  if (!room) return;
  if (enabled && !micTrack) {
    await room.localParticipant.setMicrophoneEnabled(true);
    micTrack = true;
  } else if (!enabled && micTrack) {
    await room.localParticipant.setMicrophoneEnabled(false);
    micTrack = false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getParticipantCount() {
  if (!room) return 0;
  return room.numParticipants; // includes local
}

export function getRoomName() {
  return room?.name ?? null;
}
