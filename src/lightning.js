/**
 * lightning.js — Lightning payment controller (frontend side).
 *
 * Session model (Phase 2):
 *   The session code is the SAME code the players share for co-op presence.
 *   Call activateWithCode(roomCode) from coop-hud.js after a successful join.
 *   This registers the code on the server (PUT /session/:code) and starts
 *   polling paidCount. Both players poll the same code → server-authoritative
 *   upgrade propagation with no LiveKit data-channel plumbing.
 *
 * One payment per session upgrades ALL players. Once paidCount >= 1, the HUD
 * disables the pay button and grants rapid-fire to every client on their next poll.
 *
 * Public API:
 *   isLightningEnabled()    — is VITE_LIGHTNING=on?
 *   getSessionCode()        — current code (the coop room code, or null)
 *   getPaidCount()          — settled payments for this session
 *   activateWithCode(code, authToken)
 *                           — point Lightning at a session + start polling. authToken
 *                             is the token valid FOR THAT CODE: ownerToken for your
 *                             own code (solo or hosting), paymentToken for a friend's.
 *   isPaidCountKnown()      — false until the first answer for the current code
 *   deactivate()            — stop polling (call on leave)
 *   createInvoice()         — POST a 21-sat invoice, returns { payment_request, payment_hash }
 *   getBackendUrl()         — for dev simulate-payment button
 */

const LIGHTNING_ON = import.meta.env.VITE_LIGHTNING === 'on';
// Normalize: add https:// if env var was set without protocol (avoids relative-URL fetch).
function _normalizeBackend(raw, fallback) {
  const s = (raw || fallback).replace(/\/+$/, '');
  return s.startsWith('http') ? s : `https://${s}`;
}
const BACKEND_URL = _normalizeBackend(
  import.meta.env.VITE_BACKEND_URL,
  'https://sats-arena-4-production.up.railway.app',
);

const POLL_MS = 2500;

let code          = null;
let paidCount     = 0;
let _known        = false; // has the server answered for the CURRENT code yet?
let _pollTimer    = null;
let _authToken    = null;  // the token valid for `code` — never another session's

export function isLightningEnabled()      { return LIGHTNING_ON; }
export function getSessionCode()          { return code; }
export function getPaidCount()            { return paidCount; }
export function isPaidCountKnown()        { return _known; }
export function getBackendUrl()           { return BACKEND_URL; }

/**
 * activateWithCode(roomCode, authToken) — point Lightning at a session.
 *
 * Pre-present fix A: this used to run only AFTER the LiveKit join succeeded, so a
 * solo player whose own-room join failed (or was slow) never got a buyable RAPID
 * FIRE, and LEAVE deactivated it for good. coop-hud.js now calls it the moment
 * the code is claimed, and again on join/leave. It also used to poll with the
 * device's OWN ownerToken even inside a friend's session, which that session
 * rejects (403) — the token now always travels with the code it belongs to.
 *
 * The code is set synchronously so the HUD can offer the purchase at once; the
 * PUT is only a touch, and polling starts whether or not it succeeds.
 */
export function activateWithCode(roomCode, authToken = null) {
  if (!LIGHTNING_ON || !roomCode) return;
  if (code === roomCode && _authToken === authToken && _pollTimer !== null) return;
  deactivate(); // clean up any prior poll
  code       = roomCode;
  _authToken = authToken || null;
  fetch(`${BACKEND_URL}/session/${roomCode}`, { method: 'PUT' })
    .catch((err) => console.warn('[lightning] session touch failed', err));
  startPolling();
}

/** Stop polling and clear state (called on leave). */
export function deactivate() {
  if (_pollTimer !== null) {
    clearTimeout(_pollTimer);
    _pollTimer = null;
  }
  code       = null;
  paidCount  = 0;
  _known     = false;
  _authToken = null;
}

export async function createInvoice() {
  if (!code) throw new Error('no session code yet — try again in a moment');
  const res = await fetch(`${BACKEND_URL}/session/${code}/invoice`, { method: 'POST' });
  if (!res.ok) throw new Error(`invoice failed (${res.status})`);
  return res.json(); // { payment_hash, payment_request }
}

// ── Internals ──────────────────────────────────────────────────────────────────

function startPolling() {
  const forCode = code;
  const tick = async () => {
    if (code !== forCode) return;          // superseded by a newer activate
    try {
      const headers = _authToken ? { Authorization: `Bearer ${_authToken}` } : {};
      const res  = await fetch(`${BACKEND_URL}/session/${forCode}`, { headers });
      if (res.ok && code === forCode) {
        const data = await res.json();
        if (data.exists && typeof data.paidCount === 'number') {
          paidCount = data.paidCount;
          _known    = true;
        }
      }
    } catch {
      // transient — retry next tick
    } finally {
      if (code === forCode) _pollTimer = setTimeout(tick, POLL_MS);
    }
  };
  tick();
}
