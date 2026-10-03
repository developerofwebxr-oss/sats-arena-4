/**
 * pay.js — the lightweight payment page (pay.html).
 *
 * Opened on a phone (or second window) to pay for a game session by its code:
 *   1. read ?code=XXXX (or prompt for manual entry)
 *   2. validate the code exists on the backend
 *   3. create a 21-sat invoice for THAT session
 *   4. show Open-in-Wallet + QR + Copy
 *
 * It deliberately does NOT poll for payment — only the game polls, to avoid two
 * pollers racing the backend's "mark paid" step. The payer confirms in their
 * wallet; the game shows "PAID — ACTIVATE".
 */

import QRCode from 'qrcode';

// Same normalisation as lightning.js, and the same (THIS project's) fallback —
// it used to default to the sibling sats-arena backend.
const BACKEND_URL = (() => {
  const raw = (import.meta.env.VITE_BACKEND_URL
    || 'https://sats-arena-4-production.up.railway.app').replace(/\/+$/, '');
  return raw.startsWith('http') ? raw : `https://${raw}`;
})();

const codeLine  = document.getElementById('code-line');
const codeEntry = document.getElementById('code-entry');
const codeInput = document.getElementById('code-input');
const joinBtn   = document.getElementById('join');
const qrCard    = document.getElementById('qr-card');
const qrImg     = document.getElementById('qr');
const openLink  = document.getElementById('open');
const copyBtn   = document.getElementById('copy');
const statusEl  = document.getElementById('status');

let invoiceStr = '';

function setStatus(msg, color = '#f7931a') {
  statusEl.textContent = msg;
  statusEl.style.color = color;
}

// Validate the code, then create + show an invoice for it.
async function startForCode(rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) {
    showCodeEntry('enter the 4-character code shown in the game');
    return;
  }

  setStatus('checking session…');
  codeEntry.style.display = 'none';

  try {
    // Fix A: no separate existence check. GET /session/:code is owner/reader-only
    // (it closed a public enumeration oracle), so the old check answered 403 —
    // "not found" — for EVERY code and this page could never pay. The invoice
    // endpoint itself now refuses unknown codes with a 404.
    setStatus('creating invoice…');
    const res = await fetch(`${BACKEND_URL}/session/${code}/invoice`, { method: 'POST' });
    if (res.status === 404) {
      showCodeEntry('session not found or expired — check the code');
      return;
    }
    if (res.status === 429) {
      showCodeEntry('too many tries — wait a minute and try again');
      return;
    }
    const inv = await res.json();
    if (!inv.payment_request) throw new Error('no invoice');
    codeLine.textContent = `session ${code} · pay 21 sats`;
    invoiceStr = inv.payment_request;

    openLink.href = `lightning:${invoiceStr}`;
    openLink.style.display = 'inline-block';
    copyBtn.style.display = 'inline-block';
    qrImg.src = await QRCode.toDataURL(invoiceStr.toUpperCase(), { margin: 1, width: 240 });
    qrCard.style.display = 'inline-block';
    setStatus('pay in your wallet, then return to the game');
  } catch (err) {
    console.warn(err);
    setStatus('could not reach the payment server — try again', '#ff4444');
  }
}

function showCodeEntry(msg) {
  codeLine.textContent = '';
  qrCard.style.display = 'none';
  openLink.style.display = 'none';
  copyBtn.style.display = 'none';
  codeEntry.style.display = 'flex';
  if (msg) setStatus(msg, '#ffaa00');
  else setStatus('');
}

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(invoiceStr);
    copyBtn.textContent = '✓ COPIED';
    setTimeout(() => { copyBtn.textContent = 'COPY INVOICE'; }, 1500);
  } catch {
    copyBtn.textContent = 'COPY FAILED';
  }
});

joinBtn.addEventListener('click', () => startForCode(codeInput.value));
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') startForCode(codeInput.value); });

// Boot: use ?code= if present, else show manual entry.
const params = new URLSearchParams(location.search);
const initialCode = (params.get('code') || '').trim().toUpperCase();
if (initialCode) {
  codeInput.value = initialCode; // prefill the field so it's visible even if validation falls back to manual entry
  startForCode(initialCode);
} else {
  showCodeEntry('');
}
