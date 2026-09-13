// qrcode (24 KB) is only needed the moment a Lightning invoice is shown, so it
// is import()ed at the call site rather than parsed on every page load.
import { playReloadSound } from './audio.js';
import { grantRapidFire, isRapidFire, getRemainingSeconds } from './upgrade.js';
import { isLightningEnabled, getSessionCode, getPaidCount, createInvoice } from './lightning.js';
import { getScore } from './score.js';

/**
 * hud.js — all DOM overlays.
 *
 * Free-to-play HUD (no balance / currency):
 *   - RAPID FIRE status box (top-right): buyable when idle, live countdown while
 *     an active window runs. Repeatable — pay again after a window ends.
 *   - On-screen SHOOT button (bottom-right)
 *
 * Shooting is free and unlimited. The upgrade purchase IS the upgrade — there's
 * nothing to deduct from.
 */

const RAPID_FIRE_PRICE = 21; // sats — display + (later) the Lightning invoice amount

let scoreEl;        // running SCORE
let lastShownScore = -1;
let upgradeBtn;

// Session upgrade model (Prompt 18 + 25):
//   Each payment upgrades ALL players and is REPEATABLE. paidCount comes from the
//   server poll in lightning.js and only ever increases. We detect a payment as
//   paidCount INCREASING since last seen — each increment starts a fresh 60s
//   window on BOTH clients (host + joiner each poll the same counter). The status
//   box reflects the ACTIVE WINDOW (isRapidFire()), not the permanent paid flag,
//   so it reverts to buyable when the window ends and a new payment works again.
let lastPaid       = 0;   // highest paidCount seen — a higher value = fresh payment
let sessionGranted = false; // legacy: kept for the VR ACTIVATE panel charge API

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

// ── The top-left readouts (P56) ──────────────────────────────────────────────
/**
 * SCORE and SESSION are one type object in two places: same family, same size,
 * WORD at 400 and VALUE at 700. Exported so coop-hud.js builds its chip through
 * the same function rather than through a matching-looking string — one weight
 * pair, one size, one place to change them.
 *
 * Both parts are written with textContent, never interpolated into innerHTML:
 * the session code arrives from the network.
 */
export const HUD_READOUT_PX = 14;

// RAPID FIRE's two lines, with explicit line-heights so the box's height is
// arithmetic rather than whatever the font's default leading happens to be:
// 6 + 14 + 2 + 10 + 6 + 2px of border = 40px. Its top edge is the SESSION chip's
// (both 16) and its bottom edge lands on the SCORE line's (both 56) — that
// span-for-span match is what "aligned with the session chip and score" means
// here, and it is why the numbers are chosen rather than eyeballed.
const RF_TITLE_PX = 14;
const RF_SUB_PX   = 10;

// SHOOT's circle and its target glyph.
const SHOOT_PX      = 84;
const SHOOT_ICON_PX = 60;

export function setReadout(el, word, value) {
  if (!el) return;
  let w = el.querySelector('.hud-word');
  let v = el.querySelector('.hud-value');
  if (!w || !v) {
    el.textContent = '';
    w = document.createElement('span'); w.className = 'hud-word';
    v = document.createElement('span'); v.className = 'hud-value';
    el.append(w, document.createTextNode(' '), v);
  }
  w.textContent = word;
  v.textContent = value;
}

// ── Styles ─────────────────────────────────────────────────────────────────
function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes lightning-pulse {
      0%   { box-shadow: 0 0 12px var(--ui-glow-soft), 0 0 24px var(--ui-glow-soft); }
      50%  { box-shadow: 0 0 28px var(--ui-glow-strong), 0 0 56px var(--ui-glow-mid); }
      100% { box-shadow: 0 0 12px var(--ui-glow-soft), 0 0 24px var(--ui-glow-soft); }
    }
    /* RAPID FIRE: sub-line justified to the title's glyph edges (P59). */
    #upgrade-btn .rf-title { letter-spacing: 0.12em; margin-right: -0.12em; white-space: nowrap; }
    #upgrade-btn .rf-sub   { display: flex; justify-content: space-between; align-items: baseline;
                             letter-spacing: 0.12em; white-space: nowrap; }
    #upgrade-btn .rf-last  { margin-right: -0.12em; }
    #upgrade-btn .rf-dot   { opacity: .55; }

    /* One weight pair for both top-left readouts. */
    #score, #session-chip { font-size: ${HUD_READOUT_PX}px; }
    .hud-word  { font-weight: 400; opacity: 0.85; }
    .hud-value { font-weight: 700; }

    #upgrade-btn { animation: lightning-pulse 1.4s ease-in-out infinite; }
    #upgrade-btn.active {
      /* While rapid-fire is running, the button glows magenta to show it's live. */
      animation: none;
      border-color: var(--ui-accent);
      color: var(--ui-accent);
      text-shadow: 0 0 10px var(--ui-accent);
      box-shadow: 0 0 24px var(--ui-accent-line);
    }

    /* Loading spinner for the "creating invoice…" button state. */
    @keyframes mini-spin { to { transform: rotate(360deg); } }
    .mini-spinner {
      display: inline-block; width: 12px; height: 12px; vertical-align: middle;
      border: 2px solid var(--ui-glow-soft); border-top-color: var(--ui-glow);
      border-radius: 50%; animation: mini-spin 0.7s linear infinite;
    }

    /* Narrow phones: a touch tighter again, but top:16 is NOT overridden — the
       box's top edge lines up with the SESSION chip's at every width, which is
       the alignment the balance pass was about. */
    @media (max-width: 480px) {
      #upgrade-btn { padding: 6px 10px; right: 12px; }
      #upgrade-btn > div:first-child { font-size: 13px !important; }
      #upgrade-btn > div:last-child  { font-size: 9px !important; }
      #shoot-btn { right: 14px; }
    }

    /* ── SHOOT's vertical home, per orientation (P56) ──────────────────────────
       It used to float at bottom:90 in portrait, which put it a third of the way
       up the screen and well above the HUD grid — the two bottom-corner controls
       read as belonging to different screens. It now sits on the SAME baseline as
       the grid (both bottom:16), so the corner reads as one row.

       Landscape gets its own, lower value rather than the same one: the viewport
       is ~390px tall there, the grid already eats 110px of it, and the thumb
       naturally falls lower on a phone held sideways. 24 -> 10 is the "a bit
       lower" half of the request; portrait's 90 -> 16 is the "a lot lower" half.
       !important overrides the inline bottom set in JS. */
    @media (orientation: landscape) {
      #shoot-btn { bottom: 10px !important; }
    }
  `;
  document.head.appendChild(style);
}


// ── Score visibility arbiter (A2) ────────────────────────────────────────────
// TWO independent features want the top-left SCORE hidden, and they must not
// fight over one DOM property:
//
//   'match'      competition.js hides it during a match, because the dual-score
//                HUD already shows YOU vs THEM and two "your score" readouts is
//                confusing.
//   'handheldAR' phone AR draws the score as an in-world sprite (vrui.js shows
//                it whenever a session is presenting), so the DOM one is a
//                duplicate. armode.js exported isHandheldAR() for exactly this
//                and nothing ever called it.
//
// A per-frame writer (the SA2 approach) would have stomped competition.js's
// hide every frame. Instead each feature declares its own reason and this is the
// ONLY place #score's display is assigned: hidden if ANY reason wants it hidden,
// shown only when none do. Neither feature can clear the other's hide, and the
// order they arrive in does not matter.
const _scoreHideReasons = { match: false, handheldAR: false };

/**
 * @param {'match'|'handheldAR'} reason
 * @param {boolean} hidden
 */
export function setScoreHidden(reason, hidden) {
  if (!(reason in _scoreHideReasons)) {
    console.warn(`[hud] unknown score-hide reason "${reason}"`);
    return;
  }
  _scoreHideReasons[reason] = !!hidden;
  applyScoreVisibility();
}

/** True when any feature currently wants the DOM score hidden. */
export function isScoreHidden() {
  return Object.values(_scoreHideReasons).some(Boolean);
}

function applyScoreVisibility() {
  // Resolve from the DOM if createHUD has not run yet, rather than dropping the
  // request on the floor. armode and competition both happen to be wired after
  // createHUD today, but a silent no-op that depends on module init order is
  // exactly the kind of thing that comes back as "it works on my machine".
  const el = scoreEl || document.getElementById('score');
  if (!el) return;
  el.style.display = isScoreHidden() ? 'none' : '';
}

// DEV: the arbiter, so a headless check drives the SAME module instance the app
// uses. (A dynamic import() of this file from a test would otherwise get its own
// copy under the Vite dev server, with its own reason flags.)
if (import.meta.env.DEV) {
  window.__hud = { setScoreHidden: (r, h) => setScoreHidden(r, h), isScoreHidden: () => isScoreHidden() };
}

// ── createHUD ─────────────────────────────────────────────────────────────────

export function createHUD(onShoot) {
  injectStyles();

  // The active rapid-fire countdown lives in the top-RIGHT status box (the upgrade
  // button), not top-left — top-left is SESSION (coop-hud) + SCORE only, so the
  // three lines never collide. See updateStatusBox().

  // ── SCORE (top-left, below the SESSION chip from coop-hud.js) ─────────────────
  // P56: the same 14px monospace the SESSION chip uses, so the two lines of the
  // top-left column read as one block instead of two unrelated readouts. Within
  // the line the WORD is 400 and the NUMBER is 700 — the label is the quiet part,
  // the value is the part you glance at. SESSION is built the same way in
  // coop-hud.js; the shared class names are what keep them in step.
  scoreEl = document.createElement('div');
  scoreEl.id = 'score';
  scoreEl.style.cssText = `
    position: fixed;
    top: 40px;
    left: 16px;
    font-family: monospace;
    font-size: ${HUD_READOUT_PX}px;
    letter-spacing: 0.12em;
    color: var(--ui-glow);
    text-shadow: 0 0 10px var(--ui-glow);
    pointer-events: none;
    user-select: none;
  `;
  setReadout(scoreEl, 'SCORE', '0');
  document.body.appendChild(scoreEl);
  applyScoreVisibility();   // honour any reason registered before the HUD existed

  // ── RAPID FIRE purchase button (top-right) ──────────────────────────────────
  // Tap = buy 60s of rapid-fire for the whole session. Hidden when not in a session
  // or after the session has already been upgraded.
  upgradeBtn = document.createElement('button');
  upgradeBtn.id = 'upgrade-btn';
  // P56: the box used to be 18px/12px inside 14x22 padding, which made it the
  // heaviest object on screen and left the top-left column (SESSION + SCORE)
  // looking like a footnote beside it. It is now sized to that column: same
  // top:16 as the SESSION chip, and a height that lands on the SCORE line rather
  // than hanging below it. See RF_* below.
  // P59: the sub-line is FULL-JUSTIFIED to the title — the "2" of "21 sats"
  // under the "R", the "s" of "60s" under the "E". Two mechanisms make that exact
  // rather than approximate:
  //
  //   · The box shrinks to its widest line, which is the title, so the sub-line's
  //     flex row IS the title's width and space-between spreads "21 sats · 60s"
  //     end to end across it. No measured pixel is copied anywhere, so it holds at
  //     the phone's 13/9px and the desktop's 14/10px alike.
  //
  //   · letter-spacing is applied AFTER every character, the last one included, so
  //     each line's box ends one tracking-width past its final glyph — and the
  //     title (0.12em of 14px) and the sub-line (0.12em of 10px) overshoot by
  //     DIFFERENT amounts. A negative right margin of exactly one tracking cancels
  //     it on both, so what gets aligned is where the "E" and the "s" end, not
  //     where their invisible trailing space does.
  upgradeBtn.innerHTML = `
    <div style="font:${RF_TITLE_PX}px/1 monospace;"><span class="rf-title">RAPID FIRE</span></div>
    <div class="rf-sub" style="font:${RF_SUB_PX}px/1 monospace; margin-top:3px; opacity:0.8;"><span>${RAPID_FIRE_PRICE} sats</span><span class="rf-dot">·</span><span class="rf-last">60s</span></div>
  `;
  upgradeDefaultHTML = upgradeBtn.innerHTML;
  upgradeBtn.style.cssText = `
    position: fixed;
    top: 16px;
    right: 16px;
    padding: 6px 12px;
    text-align: left;
    background: var(--ui-panel);
    color: var(--ui-glow);
    border: 1px solid var(--ui-glow);
    font-family: monospace;
    cursor: pointer;
    text-shadow: 0 0 10px var(--ui-glow);
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
  // P56: 92 -> 84px. Small enough that the column (84 + 6 + 13 = 103px) reads as
  // the same order of object as the 94px HUD grid opposite it, and still nearly
  // double the 44px minimum touch target.
  shootBtn.innerHTML = `
    <div style="
      width: ${SHOOT_PX}px; height: ${SHOOT_PX}px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      background: var(--ui-primary-dim); border: 2px solid var(--ui-primary);
      box-shadow: 0 0 22px var(--ui-primary-line);
    ">
      <svg width="${SHOOT_ICON_PX}" height="${SHOOT_ICON_PX}" viewBox="0 0 100 100" fill="none" stroke="var(--ui-primary)"
           stroke-width="5" stroke-linecap="round" style="filter: drop-shadow(0 0 4px var(--ui-primary));">
        <circle cx="50" cy="50" r="15" />
        <line x1="50" y1="4"  x2="50" y2="30" />
        <line x1="50" y1="70" x2="50" y2="96" />
        <line x1="4"  y1="50" x2="30" y2="50" />
        <line x1="70" y1="50" x2="96" y2="50" />
      </svg>
    </div>
    <div style="margin-top: 6px; font-size: 12px; letter-spacing: 0.18em; color: var(--ui-primary); text-shadow: 0 0 8px var(--ui-primary);">SHOOT</div>`;
  // Bottom-right, on the same baseline as the HUD grid. Width = circle so it sits
  // cleanly in the corner in both portrait and landscape; the landscape media
  // query above overrides `bottom` and explains why it differs there.
  shootBtn.style.cssText = `
    position: fixed;
    bottom: 16px;
    right: 20px;
    width: ${SHOOT_PX}px;
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
    background: var(--ui-panel);
    z-index: 300;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    font-family: monospace;
    color: var(--ui-glow);
    text-align: center;
    padding: 24px;
  `;

  const title = document.createElement('div');
  title.textContent = 'PAY 21 SATS';
  title.style.cssText = 'font-size: 20px; letter-spacing: 0.12em; text-shadow: 0 0 8px var(--ui-glow);';

  payModalCode = document.createElement('div');
  payModalCode.style.cssText = 'font-size: 12px; letter-spacing: 0.18em; opacity: 0.7;';

  // White card behind the QR so it scans reliably.
  const qrCard = document.createElement('div');
  // NOT THEMED, on purpose: a Lightning QR needs a white quiet zone to scan
  // reliably. Tinting it to match a skin would trade money for decoration.
  qrCard.style.cssText = 'background:#fff; padding:12px; border-radius:6px; line-height:0;';
  payModalQr = document.createElement('img');
  payModalQr.width = 240;
  payModalQr.height = 240;
  payModalQr.alt = 'Lightning invoice QR';
  qrCard.appendChild(payModalQr);

  // Open in Wallet — a lightning: link so a phone opens its wallet directly
  // (attendees on a single phone can't scan their own screen).
  payModalOpenLink = document.createElement('a');
  payModalOpenLink.textContent = 'OPEN IN WALLET';
  payModalOpenLink.style.cssText = `
    display: inline-block; padding: 14px 26px; background: var(--ui-glow); color: var(--ui-on-glow);
    font-family: monospace; font-size: 16px; font-weight: bold; letter-spacing: 0.08em;
    text-decoration: none; border-radius: 4px; cursor: pointer;
  `;
  payModalOpenLink.addEventListener('click', (e) => e.stopPropagation());

  // Copy invoice — fallback for pasting into a wallet manually.
  payModalCopyBtn = document.createElement('button');
  payModalCopyBtn.textContent = 'COPY INVOICE';
  payModalCopyBtn.style.cssText = `
    padding: 10px 20px; background: transparent; color: var(--ui-glow);
    border: 1px solid var(--ui-glow); font-family: monospace; letter-spacing: 0.1em; cursor: pointer;
  `;
  payModalCopyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(currentInvoice);
      payModalCopyBtn.textContent = 'COPIED';
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
    color: var(--ui-text-muted); border: 1px solid var(--ui-text-muted); font-family: monospace;
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
  payModalStatus.style.color = 'var(--ui-glow)';
  // lightning: URI uses the canonical lowercase invoice; tapping opens the wallet.
  payModalOpenLink.href = `lightning:${invoice}`;
  payModalCopyBtn.textContent = 'COPY INVOICE';
  payModal.style.display = 'flex';

  try {
    // Uppercase the bech32 invoice for QR alphanumeric mode → less dense, easier scan.
    const { default: QRCode } = await import('qrcode');
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
  if (isRapidFire()) return; // a window is already running — buy again once it ends

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
    payModalStatus.style.color = 'var(--ui-danger)';
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
// Called every frame from main.js. Detects repeat payments (paidCount increment)
// and drives the top-right status box off the ACTIVE WINDOW, not the paid flag.
export function updateRapidFireHUD() {
  // SCORE (top-left) — only re-render the text when it actually changes.
  const score = getScore();
  if (score !== lastShownScore) {
    lastShownScore = score;
    setReadout(scoreEl, 'SCORE', String(score));
  }

  // ── Detect a fresh/repeat payment: paidCount INCREASING since last seen ──────
  // Each increment starts a fresh 60s window. Server-authoritative and shared:
  // host + joiner each poll the same session's paidCount (ownerToken /
  // paymentToken) and independently grant, so one payment still upgrades BOTH —
  // now repeatable. Not gated on sessionGranted, so a 2nd payment re-triggers.
  if (isLightningEnabled() && getSessionCode()) {
    const paid = getPaidCount();
    if (paid > lastPaid) {
      lastPaid = paid;
      closePaymentModal();
      grantRapidFire();      // fresh window on EVERY increment (repeatable)
      sessionGranted = true; // legacy VR charge-panel suppression (unchanged)
    }
  }

  // ── Top-right status box: buyable ⇄ live countdown, driven by active window ──
  updateStatusBox(isRapidFire());
}

// Status box states (top-right #upgrade-btn):
//   active window → live countdown "▶ RAPID FIRE m:ss" (magenta glow, not tappable)
//   idle + in a lightning session → buyable "⚡ RAPID FIRE / 21 sats · 60s"
//   idle + no session / no lightning → hidden
// State is the ACTIVE WINDOW, never the permanent paidCount — so it reverts to
// buyable at 0:00 and a repeat payment works again.
function updateStatusBox(active) {
  upgradeBtn.classList.toggle('active', active);

  if (active) {
    const secs = getRemainingSeconds();
    if (secs !== lastShownSecond) {
      lastShownSecond = secs;
      const m = Math.floor(secs / 60);
      const s = String(secs % 60).padStart(2, '0');
      upgradeBtn.innerHTML = `<div style="font:${RF_TITLE_PX}px/1 monospace; letter-spacing:0.12em;">▶ RAPID FIRE ${m}:${s}</div>`;
    }
    upgradeBtn.disabled = true;
    upgradeBtn.style.cursor = 'default';
    upgradeBtn.style.opacity = '1';
    upgradeBtn.style.display = 'block';
    return;
  }

  // Window ended (or never ran) — force a re-render on the next active window.
  lastShownSecond = -1;

  // Don't clobber the "CREATING INVOICE…" spinner mid-purchase.
  if (purchasing) return;

  // Reset to the clean buyable look — also clears any stale countdown text so a
  // hidden box never keeps "▶ RAPID FIRE 0:0x" from the window that just ended.
  if (upgradeBtn.innerHTML !== upgradeDefaultHTML) upgradeBtn.innerHTML = upgradeDefaultHTML;
  upgradeBtn.disabled = false;
  upgradeBtn.style.opacity = '1';
  upgradeBtn.style.cursor = 'pointer';

  // Visible (buyable) only inside a lightning session; otherwise hidden.
  upgradeBtn.style.display = (isLightningEnabled() && getSessionCode()) ? 'block' : 'none';
}
