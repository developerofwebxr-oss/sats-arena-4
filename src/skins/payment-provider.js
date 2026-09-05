/**
 * payment-provider.js — the entry-gate seam for skins.
 *
 * A skin may cost sats to unlock. Today NOTHING is gated: the mock provider
 * auto-approves everything at 0 sats so the art/scoping work can be tuned
 * without a paywall in the way.
 *
 * SWAPPABLE BY PROVIDER SWAP, NOT SURGERY
 *   Callers only ever see the PaymentProvider shape below. To go live, write a
 *   LightningPaymentProvider with the same three methods and call
 *   setPaymentProvider(new LightningPaymentProvider()) once at boot — no call
 *   site changes.
 *
 * NO SECRETS ON THE CLIENT
 *   This file holds no keys and never will. The real provider follows the same
 *   static-client / secret-backend split the rest of the app already uses
 *   (lightning.js + server/server.js): the client asks the backend to create an
 *   invoice and polls for settlement; the LNbits key lives only on the server.
 *
 * The interface:
 *   isUnlocked(skinId)        → bool      cheap, synchronous, drives dimming
 *   priceSats(skin)           → number    0 = free
 *   requestUnlock(skin)       → Promise<{ok, reason?}>
 */

/**
 * MockPaymentProvider — everything is free and already unlocked.
 * This is the ONLY provider wired up right now.
 */
export class MockPaymentProvider {
  constructor() { this.kind = 'mock'; }

  // Nothing is gated while tuning.
  isUnlocked(_skinId) { return true; }

  // 0-sat auto-entry.
  priceSats(_skin) { return 0; }

  // Auto-approve. Async so the real provider (which must await an invoice
  // settling) is a drop-in with no call-site change.
  async requestUnlock(_skin) { return { ok: true }; }
}

/**
 * Reference shape for the real thing — intentionally NOT wired up.
 * Sketched here so the swap is obviously a swap and not a rewrite.
 *
 * export class LightningPaymentProvider {
 *   constructor() { this.kind = 'lightning'; this._unlocked = new Set(); }
 *   isUnlocked(skinId) { return this._unlocked.has(skinId); }
 *   priceSats(skin)    { return skin.entry?.sats ?? 0; }
 *   async requestUnlock(skin) {
 *     // POST /session/:code/invoice on the EXISTING backend (holds the key),
 *     // show the QR the HUD already knows how to render, poll for settlement,
 *     // then: this._unlocked.add(skin.id); return { ok: true };
 *   }
 * }
 */

let _provider = new MockPaymentProvider();

/** Swap the provider. The one call that turns the mock paywall into a real one. */
export function setPaymentProvider(p) { _provider = p; }

/** Current provider. */
export function getPaymentProvider() { return _provider; }

// ── Convenience wrappers so call sites never hold a provider reference ────────
export function isSkinUnlocked(skinId) { return _provider.isUnlocked(skinId); }
export function skinPriceSats(skin)    { return _provider.priceSats(skin); }
export function requestSkinUnlock(skin) { return _provider.requestUnlock(skin); }
