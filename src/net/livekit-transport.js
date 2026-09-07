import { Room, RoomEvent, Track } from 'livekit-client';

/**
 * livekit-transport.js — the real LiveKit transport, split out of room.js.
 *
 * WHY IT LIVES IN ITS OWN MODULE (Prompt 39):
 * livekit-client is 508 KB raw / 133 KB gzipped — 42% of the whole bundle — and
 * NOTHING on the path to the first interactive frame touches it. Statically
 * imported it was parsed and evaluated before the player could move. room.js now
 * import()s this module only when someone actually joins a session, so the cost
 * lands on the join, not on the load.
 *
 * This is a pure extraction: the class body is byte-for-byte the behaviour that
 * shipped, with room.js's module-scope helpers (the callback fan-out, the
 * LiveKit URL, the token fetch, the audio sink) passed in as constructor deps
 * instead of being closed over. No protocol, event wiring or mute semantics
 * changed.
 */

const _ENC = new TextEncoder();

export class LiveKitTransport {
  constructor({ cb, lkUrl, fetchToken, audioSink }) {
    this._cb        = cb;
    this._lkUrl     = lkUrl;
    this._fetchToken = fetchToken;
    this._audioSink  = audioSink;
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
      this._audioSink().appendChild(el);
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
    const emit = () => this._cb.onMicState(room.localParticipant.isMicrophoneEnabled);
    room.on(RoomEvent.LocalTrackPublished,   emit);
    room.on(RoomEvent.LocalTrackUnpublished, emit);
    room.on(RoomEvent.TrackMuted,            emit);
    room.on(RoomEvent.TrackUnmuted,          emit);
  }

  async join(roomName, identity, { ownerToken, admissionTicket } = {}) {
    if (this._room) await this.leave();
    if (!this._lkUrl) throw new Error('VITE_LIVEKIT_URL is not set. Add it to .env.local.');

    const token = await this._fetchToken(roomName, identity, ownerToken, admissionTicket);
    const room  = new Room({ adaptiveStream: true, dynacast: true });

    room.on(RoomEvent.DataReceived, (payload, participant) => {
      if (!participant) return;
      let msg;
      try { msg = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
      const pid = participant.identity, pname = participant.name || participant.identity;
      if (msg.t === 'pose') this._cb.onPeerPose(msg, pid, pname);
      else                  this._cb.onPeerEvent(msg, pid, pname);
    });

    room.on(RoomEvent.ParticipantConnected,    (p) => this._cb.onPeerJoin(p.identity, p.name || p.identity));
    room.on(RoomEvent.ParticipantDisconnected, (p) => this._cb.onPeerLeave(p.identity));

    this._wireRemoteAudio(room); // remote voice → <audio> elements (must precede connect)
    this._wireMicState(room);    // real local mic state → UI

    // autoSubscribe pulls peer audio down; _wireRemoteAudio is what makes it audible.
    // NOTE: the mic is deliberately NOT published here — players join MUTED and
    // opt in via the mute control (no hot mic, no permission prompt at load).
    await room.connect(this._lkUrl, token, { autoSubscribe: true });
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
    this._cb.onMicState(false); // no room → definitively not transmitting
  }

  sendPose(pose) {
    if (!this._room || this._room.state !== 'connected') return;
    const data = _ENC.encode(JSON.stringify({ t: 'pose', ...pose }));
    this._room.localParticipant.publishData(data, { reliable: false });
  }

  sendEvent(evt, { reliable = false } = {}) {
    if (!this._room || this._room.state !== 'connected') return;
    const data = _ENC.encode(JSON.stringify(evt));
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
