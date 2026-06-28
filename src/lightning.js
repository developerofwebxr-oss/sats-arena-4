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
 *   activateWithCode(code)  — register the coop code + start polling (call after join)
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

let code       = null;
let paidCount  = 0;
let _pollTimer = null;
let _ownerToken = null;

export function isLightningEnabled()    { return LIGHTNING_ON; }
export function getSessionCode()        { return code; }
export function getPaidCount()          { return paidCount; }
export function getBackendUrl()         { return BACKEND_URL; }
export function setOwnerToken(token)    { _ownerToken = token || null; }

/**
 * activateWithCode(roomCode) — call from coop-hud.js after joinSession() succeeds.
 * Registers the coop room code as the Lightning session on the server, then
 * starts polling paidCount. Idempotent: safe to call if already active.
 */
export async function activateWithCode(roomCode) {
  if (!LIGHTNING_ON) return;
  if (_pollTimer !== null) deactivate(); // clean up any prior poll

  try {
    const res  = await fetch(`${BACKEND_URL}/session/${roomCode}`, { method: 'PUT' });
    const data = await res.json();
    code      = roomCode;
    paidCount = data.paidCount || 0;
    startPolling();
  } catch (err) {
    console.warn('[lightning] session activate failed', err);
  }
}

/** Stop polling and clear state (called on leave). */
export function deactivate() {
  if (_pollTimer !== null) {
    clearTimeout(_pollTimer);
    _pollTimer = null;
  }
  code      = null;
  paidCount = 0;
}

export async function createInvoice() {
  if (!code) throw new Error('no session — join a co-op room first');
  const res = await fetch(`${BACKEND_URL}/session/${code}/invoice`, { method: 'POST' });
  if (!res.ok) throw new Error(`invoice failed (${res.status})`);
  return res.json(); // { payment_hash, payment_request }
}

// ── Internals ──────────────────────────────────────────────────────────────────

function startPolling() {
  const tick = async () => {
    if (!code) return;
    try {
      const headers = _ownerToken ? { Authorization: `Bearer ${_ownerToken}` } : {};
      const res  = await fetch(`${BACKEND_URL}/session/${code}`, { headers });
      if (res.ok) {
        const data = await res.json();
        if (data.exists && typeof data.paidCount === 'number') paidCount = data.paidCount;
      }
    } catch {
      // transient — retry next tick
    } finally {
      if (code) _pollTimer = setTimeout(tick, POLL_MS);
    }
  };
  tick();
}
