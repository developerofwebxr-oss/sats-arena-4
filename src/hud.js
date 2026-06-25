import QRCode from 'qrcode';
import { playReloadSound } from './audio.js';
import { grantRapidFire, isRapidFire, getRemainingSeconds } from './upgrade.js';
import { isLightningEnabled, getSessionCode, getPaidCount, createInvoice } from './lightning.js';
import { getScore } from './score.js';

/**
 * hud.js — all DOM overlays.
 *
 * Free-to-play HUD (no balance / currency):
 *   - RAPID FIRE purchase button (top-right) → one tap buys 60s of rapid-fire
 *   - Rapid-fire countdown (top-left) while active
 *   - On-screen SHOOT button (bottom-right)
 *
 * Shooting is free and unlimited. The upgrade purchase IS the upgrade — there's
 * nothing to deduct from.
 */

const RAPID_FIRE_PRICE = 21; // sats — display + (later) the Lightning invoice amount

let countdownEl;
let scoreEl;        // running SCORE
let lastShownScore = -1;
let upgradeBtn;

// Session upgrade model (Phase 2):
//   One payment per session upgrades ALL players. paidCount comes from the
//   server poll in lightning.js. When paidCount rises, we auto-grant rapid-fire
//   and disable the pay button so no second charge is issued.
let lastPaid       = 0;   // last paidCount seen (detect a fresh payment)
let sessionGranted = false; // rapid-fire already granted this session

let payModal;        // payment QR overlay
let payModalQr;
let payModalCode;
let payModalStatus;
let payModalOpenLink;
let payModalCopyBtn;
let currentInvoice = '';
let upgradeDefaultHTML = '';
let purchasing = false; // guard against double-taps

function setUpgradeLoading(loading) {
  purchasing = loading;
  if (loading) {
    upgradeBtn.innerHTML = `<div style="font-size:14px; letter-spacing:0.1em;"><span class="mini-spinner"></span>&nbsp; CREATING INVOICE…</div>`;
    upgradeBtn.style.cursor = 'default';
  } else {
    upgradeBtn.innerHTML = upgradeDefaultHTML;
    upgradeBtn.style.cursor = 'pointer';
  }
}
let lastShownSecond = -1; // so the countdown only re-renders when it changes

// ── Styles ─────────────────────────────────────────────────────────────────
function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes lightning-pulse {
      0%   { box-shadow: 0 0 12px rgba(247,147,26,0.4), 0 0 24px rgba(247,147,26,0.2); }
      50%  { box-shadow: 0 0 28px rgba(247,147,26,0.9), 0 0 56px rgba(247,147,26,0.5); }
      100% { box-shadow: 0 0 12px rgba(247,147,26,0.4), 0 0 24px rgba(247,147,26,0.2); }
    }
    #upgrade-btn { animation: lightning-pulse 1.4s ease-in-out infinite; }
    #upgrade-btn.active {
      /* While rapid-fire is running, the button glows magenta to show it's live. */
      animation: none;
      border-color: #b14bff;
      color: #b14bff;
      text-shadow: 0 0 10px #b14bff;
      box-shadow: 0 0 24px rgba(177,75,255,0.6);
    }

    /* Loading spinner for the "creating invoice…" button state. */
    @keyframes mini-spin { to { transform: rotate(360deg); } }
    .mini-spinner {
      display: inline-block; width: 12px; height: 12px; vertical-align: middle;
      border: 2px solid rgba(247,147,26,0.3); border-top-color: #f7931a;
      border-radius: 50%; animation: mini-spin 0.7s linear infinite;
    }

    /* Narrow phones: shrink the corner buttons so they don't crowd the top row
       or collide with the bottom controls. */
    @media (max-width: 480px) {
      #upgrade-btn { padding: 9px 12px; top: 12px; right: 12px; }
      #upgrade-btn > div:first-child { font-size: 14px !important; }
      #upgrade-btn > div:last-child  { font-size: 10px !important; }
      #shoot-btn { right: 14px; }
    }

    /* Landscape: drop the corner buttons to the bottom row (≈ the mode-switcher
       level) instead of floating mid-screen. Portrait position is unchanged.
       !important overrides the inline bottom set in JS. */
    @media (orientation: landscape) {
      #shoot-btn, #recenter-btn { bottom: 24px !important; }
    }
  `;
  document.head.appendChild(style);
}

// ── createHUD ─────────────────────────────────────────────────────────────────

export function createHUD(onShoot) {
  injectStyles();

  // ── Rapid-fire countdown (top-left) ─────────────────────────────────────────
  // Hidden unless active. Magenta to match the upgrade.
  const hud = document.createElement('div');
  hud.id = 'hud';
  hud.style.cssText = `
    position: fixed;
    top: 16px;
    left: 16px;
    font-family: monospace;
    pointer-events: none;
    user-select: none;
  `;

  countdownEl = document.createElement('div');
  countdownEl.style.cssText = `
    display: none;
    font-size: 15px;
    letter-spacing: 0.12em;
    color: #b14bff;
    text-shadow: 0 0 8px #b14bff;
  `;

  hud.append(countdownEl);
  document.body.appendChild(hud);

  // ── SCORE (top-left, below the SESSION chip from coop-hud.js) ─────────────────
  scoreEl = document.createElement('div');
  scoreEl.id = 'score';
  scoreEl.style.cssText = `
    position: fixed;
    top: 44px;
    left: 16px;
    font-family: monospace;
    font-size: 16px;
    letter-spacing: 0.12em;
    color: #f7931a;
    text-shadow: 0 0 10px #f7931a;
    pointer-events: none;
    user-select: none;
  `;
  scoreEl.textContent = 'SCORE 0';
  document.body.appendChild(scoreEl);

  // ── RAPID FIRE purchase button (top-right) ──────────────────────────────────
  // Tap = buy 60s of rapid-fire for the whole session. Hidden when not in a session
  // or after the session has already been upgraded.
  upgradeBtn = document.createElement('button');
  upgradeBtn.id = 'upgrade-btn';
  upgradeBtn.innerHTML = `
    <div style="font-size:18px; letter-spacing:0.12em;">⚡ RAPID FIRE</div>
    <div style="font-size:12px; letter-spacing:0.16em; margin-top:5px; opacity:0.8;">${RAPID_FIRE_PRICE} sats &nbsp;·&nbsp; 60s</div>
  `;
  upgradeDefaultHTML = upgradeBtn.innerHTML;
  upgradeBtn.style.cssText = `
    position: fixed;
    top: 16px;
    right: 16px;
    padding: 14px 22px;
    background: rgba(0,0,0,0.8);
    color: #f7931a;
    border: 1px solid #f7931a;
    font-family: monospace;
    text-align: center;
    cursor: pointer;
    text-shadow: 0 0 10px #f7931a;
    z-index: 200;
  `;

  upgradeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    purchaseRapidFire();
    upgradeBtn.blur();
  });

  // Hidden until joined (getSessionCode() returns non-null) and Lightning is on.
  upgradeBtn.style.display = 'none';

  document.body.appendChild(upgradeBtn);

  // ── On-screen SHOOT button (bottom-right) ───────────────────────────────────
  // For mouse-less / touch play. Fires through the centre crosshair — NDC (0,0) —
  // reusing the same fire path as click/tap/space, so it respects rapid-fire too.
  const shootBtn = document.createElement('button');
  shootBtn.id = 'shoot-btn';
  // Round primary button: bright cyan circle with a ◎ target icon, "SHOOT" below.
  shootBtn.innerHTML = `
    <div style="
      width: 92px; height: 92px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,229,255,0.18); border: 2px solid #00e5ff;
      box-shadow: 0 0 22px rgba(0,229,255,0.55);
    ">
      <svg width="66" height="66" viewBox="0 0 100 100" fill="none" stroke="#00e5ff"
           stroke-width="5" stroke-linecap="round" style="filter: drop-shadow(0 0 4px #00e5ff);">
        <circle cx="50" cy="50" r="15" />
        <line x1="50" y1="4"  x2="50" y2="30" />
        <line x1="50" y1="70" x2="50" y2="96" />
        <line x1="4"  y1="50" x2="30" y2="50" />
        <line x1="70" y1="50" x2="96" y2="50" />
      </svg>
    </div>
    <div style="margin-top: 6px; font-size: 13px; letter-spacing: 0.18em; color: #00e5ff; text-shadow: 0 0 8px #00e5ff;">SHOOT</div>`;
  // Bottom-right, above the mode switcher. Width = circle so it sits cleanly in
  // the corner in both portrait and landscape.
  shootBtn.style.cssText = `
    position: fixed;
    bottom: 90px;
    right: 20px;
    width: 92px;
    display: flex;
    flex-direction: column;
    align-items: center;
    background: transparent;
    border: none;
    padding: 0;
    font-family: monospace;
    cursor: pointer;
    z-index: 200;
  `;
  shootBtn.addEventListener('click', (e) => {
    e.stopPropagation();   // don't also fire via the window tap handler
    if (onShoot) onShoot(0, 0);
    shootBtn.blur();       // drop focus so SPACE doesn't re-click this button
  });
  document.body.appendChild(shootBtn);

  buildPaymentModal();
}

// ── Payment modal (QR) ──────────────────────────────────────────────────────
// Shown when paying with real Lightning: QR + copyable invoice + waiting state.
function buildPaymentModal() {
  payModal = document.createElement('div');
  payModal.id = 'pay-modal';
  payModal.style.cssText = `
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.88);
    z-index: 300;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    font-family: monospace;
    color: #f7931a;
    text-align: center;
    padding: 24px;
  `;

  const title = document.createElement('div');
  title.textContent = '⚡ PAY 21 SATS';
  title.style.cssText = 'font-size: 20px; letter-spacing: 0.12em; text-shadow: 0 0 8px #f7931a;';

  payModalCode = document.createElement('div');
  payModalCode.style.cssText = 'font-size: 12px; letter-spacing: 0.18em; opacity: 0.7;';

  // White card behind the QR so it scans reliably.
  const qrCard = document.createElement('div');
  qrCard.style.cssText = 'background:#fff; padding:12px; border-radius:6px; line-height:0;';
  payModalQr = document.createElement('img');
  payModalQr.width = 240;
  payModalQr.height = 240;
  payModalQr.alt = 'Lightning invoice QR';
  qrCard.appendChild(payModalQr);

  // Open in Wallet — a lightning: link so a phone opens its wallet directly
  // (attendees on a single phone can't scan their own screen).
  payModalOpenLink = document.createElement('a');
  payModalOpenLink.textContent = '⚡ OPEN IN WALLET';
  payModalOpenLink.style.cssText = `
    display: inline-block; padding: 14px 26px; background: #f7931a; color: #000;
    font-family: monospace; font-size: 16px; font-weight: bold; letter-spacing: 0.08em;
    text-decoration: none; border-radius: 4px; cursor: pointer;
  `;
  payModalOpenLink.addEventListener('click', (e) => e.stopPropagation());

  // Copy invoice — fallback for pasting into a wallet manually.
  payModalCopyBtn = document.createElement('button');
  payModalCopyBtn.textContent = 'COPY INVOICE';
  payModalCopyBtn.style.cssText = `
    padding: 10px 20px; background: transparent; color: #f7931a;
    border: 1px solid #f7931a; font-family: monospace; letter-spacing: 0.1em; cursor: pointer;
  `;
  payModalCopyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(currentInvoice);
      payModalCopyBtn.textContent = '✓ COPIED';
      setTimeout(() => { payModalCopyBtn.textContent = 'COPY INVOICE'; }, 1500);
    } catch {
      payModalCopyBtn.textContent = 'COPY FAILED';
    }
    payModalCopyBtn.blur();
  });

  payModalStatus = document.createElement('div');
  payModalStatus.textContent = '⏳ waiting for payment…';
  payModalStatus.style.cssText = 'font-size: 14px; letter-spacing: 0.08em;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'CANCEL';
  cancelBtn.style.cssText = `
    margin-top: 6px; padding: 10px 20px; background: transparent;
    color: #888; border: 1px solid #555; font-family: monospace;
    letter-spacing: 0.1em; cursor: pointer;
  `;
  cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); closePaymentModal(); cancelBtn.blur(); });

  payModal.append(title, payModalCode, qrCard, payModalOpenLink, payModalCopyBtn, payModalStatus, cancelBtn);
  document.body.appendChild(payModal);
}

async function showPaymentModal(invoice, code = getSessionCode()) {
  currentInvoice = invoice;
  payModalCode.textContent = code ? `session ${code}` : '';
  payModalStatus.textContent = '⏳ waiting for payment…';
  payModalStatus.style.color = '#f7931a';
  // lightning: URI uses the canonical lowercase invoice; tapping opens the wallet.
  payModalOpenLink.href = `lightning:${invoice}`;
  payModalCopyBtn.textContent = 'COPY INVOICE';
  payModal.style.display = 'flex';

  try {
    // Uppercase the bech32 invoice for QR alphanumeric mode → less dense, easier scan.
    payModalQr.src = await QRCode.toDataURL(invoice.toUpperCase(), { margin: 1, width: 240 });
  } catch {
    payModalStatus.textContent = 'could not render QR — use Open in Wallet or Copy';
  }
}

function closePaymentModal() {
  payModal.style.display = 'none';
}

// ── purchaseRapidFire ───────────────────────────────────────────────────────
// Creates a 21-sat invoice for the shared session code → shows QR to pay.
// Payment detection happens in updateRapidFireHUD() via the server poll.
async function purchaseRapidFire() {
  if (purchasing) return;
  if (getPaidCount() >= 1) return; // session already upgraded

  setUpgradeLoading(true);
  try {
    const { payment_request } = await createInvoice();
    setUpgradeLoading(false);
    showPaymentModal(payment_request);
  } catch (err) {
    console.warn('purchase failed', err);
    setUpgradeLoading(false);
    payModal.style.display = 'flex';
    payModalStatus.textContent = 'could not reach payment server — try again';
    payModalStatus.style.color = '#ff4444';
  }
}

// ── charge API (VR UI panel still needs getAvailableCharges / activateCharge) ─
export function getAvailableCharges() {
  return (getPaidCount() >= 1 && !sessionGranted) ? 1 : 0;
}
export function activateCharge() {
  if (sessionGranted) return;
  sessionGranted = true;
  grantRapidFire();
  playReloadSound();
}

// ── updateRapidFireHUD ──────────────────────────────────────────────────────
// Called every frame from main.js. Shows/hides the countdown and toggles the
// upgrade button's active glow. Only re-renders text when the second changes.
export function updateRapidFireHUD() {
  const active = isRapidFire();

  // SCORE — only re-render the text when it actually changes.
  const score = getScore();
  if (score !== lastShownScore) {
    lastShownScore = score;
    scoreEl.textContent = `SCORE ${score}`;
  }

  upgradeBtn.classList.toggle('active', active);

  if (active) {
    const secs = getRemainingSeconds();
    if (secs !== lastShownSecond) {
      lastShownSecond = secs;
      const m = Math.floor(secs / 60);
      const s = String(secs % 60).padStart(2, '0');
      countdownEl.textContent = `▶ RAPID FIRE ${m}:${s}`;
    }
    countdownEl.style.display = 'block';
  } else if (lastShownSecond !== -1) {
    lastShownSecond = -1;
    countdownEl.style.display = 'none';
  }

  // ── Session-shared Lightning upgrade ────────────────────────────────────────
  // Show the buy button only when joined (code set) and session not yet paid.
  // Once paidCount >= 1, auto-grant rapid-fire and lock out further purchases —
  // one payment upgrades all players for the session.
  if (!isLightningEnabled()) return;

  const code = getSessionCode();
  if (!code) {
    // Not in a session yet — hide the button.
    upgradeBtn.style.display = 'none';
    return;
  }

  const paid = getPaidCount();

  if (paid > lastPaid) {
    // Fresh payment — auto-grant rapid-fire (server-authoritative: both clients
    // poll the same session and each independently calls grantRapidFire()).
    lastPaid = paid;
    closePaymentModal();
    if (!sessionGranted) {
      sessionGranted = true;
      grantRapidFire();
    }
  }

  if (sessionGranted || paid >= 1) {
    // Session already upgraded — disable buy button.
    upgradeBtn.innerHTML = `<div style="font-size:15px; letter-spacing:0.1em;">⚡ SESSION UPGRADED ✓</div>`;
    upgradeBtn.style.cursor = 'default';
    upgradeBtn.style.display = 'block';
    upgradeBtn.disabled = true;
    upgradeBtn.style.opacity = '0.6';
  } else {
    // Joinable session, not yet paid.
    if (upgradeBtn.innerHTML !== upgradeDefaultHTML) upgradeBtn.innerHTML = upgradeDefaultHTML;
    upgradeBtn.disabled = false;
    upgradeBtn.style.opacity = '1';
    upgradeBtn.style.cursor = 'pointer';
    upgradeBtn.style.display = 'block';
  }
}
