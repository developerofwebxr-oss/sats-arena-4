import { sendEvent, onPeerEvent, onPeerLeave, getParticipantCount, getRoomName } from '../net/room.js';
import { getOwnCode } from '../net/coop-hud.js';
import { isMatchActive } from '../net/competition.js';
import { hasSkin, getSkin } from './registry.js';
import { isSkinUnlocked } from './payment-provider.js';

/**
 * skin-net.js — host-authoritative, both-ready skin switching.
 *
 * HOST AUTHORITY (the same rule coins and the competition clock already use):
 * you are the host iff getRoomName() === getOwnCode() — the owner auto-joins
 * their OWN code, a joiner is in the friend's code. Only the host may pick a
 * skin. A peer that calls requestSwitch() is refused locally; it never emits.
 *
 * WIRE PROTOCOL (all reliable — a dropped switch would desync the world):
 *   skin-switch {skinId}   HOST → peer : begin switching now
 *   skin-ready  {skinId}   either      : my world is built
 *   skin-go     {skinId}   HOST → peer : both are ready, resume
 *
 * BOTH-READY: nobody resumes into a half-built world. Each side pauses, builds,
 * and reports ready. The host resumes only once it holds ITS OWN ready AND the
 * peer's, then tells the peer to resume. Solo (no peer) skips the handshake.
 *
 * FAILSAFE: if a peer never reports ready (dropped packet, tab throttled, slow
 * asset load) we resume anyway after READY_TIMEOUT rather than freezing the game
 * forever. A stuck pause is a worse failure than a brief skin mismatch, and the
 * next switch re-syncs both sides.
 */

const READY_TIMEOUT_MS = 6000;

const isHost      = () => !!getOwnCode() && getRoomName() === getOwnCode();
const hasPeer     = () => getParticipantCount() >= 2;
const send = (t, extra = {}) => sendEvent({ t, ...extra }, { reliable: true });

export function setupSkinNet({ skins, onPauseChange, onToast }) {
  // Pending switch bookkeeping. null when idle.
  let pending = null; // { skinId, selfReady, peerReady, timer, role }

  function pause(skinId) {
    skins.setPaused(true);
    onPauseChange?.(true, getSkin(skinId)?.name || skinId);
  }
  function resume() {
    skins.setPaused(false);
    onPauseChange?.(false, null);
  }

  function clearPending() {
    if (pending?.timer) clearTimeout(pending.timer);
    pending = null;
  }

  function finish() {
    clearPending();
    resume();
  }

  function armTimeout() {
    if (pending?.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      console.warn('[skins] both-ready timed out — resuming to avoid a stuck pause');
      finish();
    }, READY_TIMEOUT_MS);
  }

  // ── Host: start a switch ────────────────────────────────────────────────────
  /**
   * @returns {{ok:boolean, reason?:string, leak?:object}}
   * Refusals are returned, not thrown — the HUD turns them into a gentle toast.
   */
  function requestSwitch(skinId) {
    if (!hasSkin(skinId))          return { ok: false, reason: 'Unknown skin' };
    if (pending)                   return { ok: false, reason: 'Already switching…' };

    // PART 6 — competition lock. Pausing a live match clock would break fairness
    // and hand players a pause-cheat, so switching is free-co-op only.
    if (isMatchActive())           return { ok: false, reason: 'Not during a match' };

    // Mock provider auto-approves everything at 0 sats today; this is the seam a
    // real paywall drops into unchanged.
    if (!isSkinUnlocked(skinId))   return { ok: false, reason: 'Skin locked' };

    // Assets still streaming — refuse rather than switch into an empty shell.
    const target = getSkin(skinId);
    if (target?.isReady && !target.isReady()) return { ok: false, reason: 'Still loading…' };

    // Peers cannot unilaterally switch — shared world, host authority.
    if (hasPeer() && !isHost())    return { ok: false, reason: 'Only the host can change skin' };

    if (skinId === skins.getActiveSkinId()) return { ok: false, reason: 'Already active' };

    const solo = !hasPeer();
    pending = { skinId, selfReady: false, peerReady: false, role: 'host' };

    pause(skinId);
    if (!solo) send('skin-switch', { skinId });

    const leak = skins.applySkinLocal(skinId);
    pending.selfReady = true;

    if (solo) {                 // nobody to wait for — but still wait for assets
      Promise.resolve(getSkin(skinId)?.whenReady?.()).then(() => finish());
      return { ok: true, leak, solo: true };
    }

    armTimeout();
    // A skin may still be streaming an asset in. Hold OUR ready until it is
    // actually in the scene — that is exactly what both-ready is for.
    Promise.resolve(getSkin(skinId)?.whenReady?.()).then(() => {
      if (!pending || pending.skinId !== skinId) return; // superseded
      send('skin-ready', { skinId });
      maybeGo();
    });
    return { ok: true, leak, solo: false };
  }

  // Host only: when both sides are built, release both.
  function maybeGo() {
    if (!pending || pending.role !== 'host') return;
    if (!(pending.selfReady && pending.peerReady)) return;
    send('skin-go', { skinId: pending.skinId });
    finish();
  }

  // ── Peer / host message handling ────────────────────────────────────────────
  onPeerEvent((msg) => {
    if (!msg || typeof msg.t !== 'string' || !msg.t.startsWith('skin-')) return;

    switch (msg.t) {
      case 'skin-switch': {
        // Host told us to switch. Trust it (host authority) but validate the id.
        if (!hasSkin(msg.skinId)) return;
        if (pending) clearPending();
        pending = { skinId: msg.skinId, selfReady: false, peerReady: false, role: 'peer' };
        pause(msg.skinId);
        skins.applySkinLocal(msg.skinId);
        armTimeout(); // resume anyway if skin-go never arrives
        Promise.resolve(getSkin(msg.skinId)?.whenReady?.()).then(() => {
          if (!pending || pending.skinId !== msg.skinId) return;
          pending.selfReady = true;
          send('skin-ready', { skinId: msg.skinId });
        });
        break;
      }

      case 'skin-ready': {
        if (!pending || msg.skinId !== pending.skinId) return;
        pending.peerReady = true;
        maybeGo(); // no-op on the peer; the host releases
        break;
      }

      case 'skin-go': {
        // Host says both are built. Only meaningful to a waiting peer.
        if (!pending || pending.role !== 'peer') return;
        if (msg.skinId !== pending.skinId) return;
        finish();
        break;
      }

      default: break;
    }
  });

  // A peer leaving mid-switch must not leave us frozen waiting for their ready.
  onPeerLeave(() => {
    if (pending) {
      console.warn('[skins] peer left mid-switch — resuming');
      finish();
    }
  });

  return {
    requestSwitch,
    isSwitching: () => !!pending,
    isHost,
    hasPeer,
    // Exposed so the HUD can explain WHY a control is dimmed.
    canSwitch() {
      if (isMatchActive())        return { ok: false, reason: 'Not during a match' };
      if (hasPeer() && !isHost()) return { ok: false, reason: 'Only the host can change skin' };
      if (pending)                return { ok: false, reason: 'Already switching…' };
      return { ok: true };
    },
  };
}
