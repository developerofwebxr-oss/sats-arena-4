// ─────────────────────────────────────────────────────────────────────────────
// Sats Arena — Lightning payment backend
//
// A thin, stateless-ish proxy in front of a hosted LNbits wallet. It holds the
// LNbits Invoice/read key (from an env var — NEVER in the repo) and exposes a
// small session-centric API the game frontend talks to. The frontend never sees
// the LNbits key or talks to LNbits directly.
//
// Endpoints:
//   GET  /health                  → { ok: true }
//   POST /session                 → { code }                     create a session
//   GET  /session/:code           → { exists, paidCount }        poll status
//   POST /session/:code/invoice   → { payment_hash, payment_request }  new invoice
//
// State is in-memory (a Map). Good enough for a demo; a restart wipes sessions,
// so avoid redeploying mid-event. A TTL sweep retires idle sessions.
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';
import cors from 'cors';
import { AccessToken } from 'livekit-server-sdk';

// ── Config (all from env; sensible defaults for everything except the secret) ──
const PORT           = process.env.PORT || 8080;
const LNBITS_URL     = (process.env.LNBITS_URL || '').replace(/\/+$/, ''); // strip trailing slash
const INVOICE_KEY    = process.env.LNBITS_INVOICE_KEY || '';
const INVOICE_AMOUNT = parseInt(process.env.INVOICE_AMOUNT || '21', 10);
// Comma-separated list of allowed browser origins. Defaults to the live game.
// Add http(s)://localhost:5173 here in Railway while testing from a dev server.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'https://developerofwebxr-oss.github.io')
  .split(',').map((s) => s.trim()).filter(Boolean);

// ── LiveKit config ─────────────────────────────────────────────────────────────
const LK_API_KEY    = process.env.LIVEKIT_API_KEY    || '';
const LK_API_SECRET = process.env.LIVEKIT_API_SECRET || '';

if (!LK_API_KEY || !LK_API_SECRET) {
  console.warn('⚠  LIVEKIT_API_KEY and/or LIVEKIT_API_SECRET are not set — /token will fail.');
}

if (!LNBITS_URL || !INVOICE_KEY) {
  console.warn('⚠  LNBITS_URL and/or LNBITS_INVOICE_KEY are not set — invoice routes will fail until they are.');
}

// ── Session store ──────────────────────────────────────────────────────────────
// code → { code, createdAt, lastSeen, paidCount, openInvoices: [hash...] }
const sessions = new Map();
// payment_hash → code (handy for debugging / a future webhook path)
const paymentToCode = new Map();

const TTL_MS       = 2 * 60 * 60 * 1000; // 2h of inactivity before a session is dropped
const SWEEP_MS     = 60 * 1000;          // run the cleanup once a minute

// 4-char codes from an unambiguous alphabet (no 0/O/1/I/L). ~31^4 ≈ 920k codes.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
  } while (sessions.has(code)); // guarantee uniqueness among live sessions
  return code;
}

// ── LNbits helpers ─────────────────────────────────────────────────────────────
async function lnbitsCreateInvoice(amount, memo) {
  const res = await fetch(`${LNBITS_URL}/api/v1/payments`, {
    method: 'POST',
    headers: { 'X-Api-Key': INVOICE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ out: false, amount, memo }),
  });
  if (!res.ok) {
    throw new Error(`LNbits create invoice failed (${res.status}): ${await res.text()}`);
  }
  // → { payment_hash, payment_request, checking_id, ... }
  return res.json();
}

async function lnbitsIsPaid(paymentHash) {
  const res = await fetch(`${LNBITS_URL}/api/v1/payments/${paymentHash}`, {
    headers: { 'X-Api-Key': INVOICE_KEY },
  });
  if (!res.ok) {
    throw new Error(`LNbits check failed (${res.status})`);
  }
  const data = await res.json(); // → { paid: bool, ... }
  return data.paid === true;
}

// ── App ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(cors({
  origin(origin, cb) {
    // Allow same-origin / non-browser callers (curl, wallets) which send no Origin.
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`Origin not allowed: ${origin}`));
  },
}));

app.get('/', (_req, res) => res.type('text').send('Sats Arena backend — ok'));
app.get('/health', (_req, res) => res.json({ ok: true }));

// Issue a LiveKit JWT. The browser calls this with a room name (= session code)
// and a display identity; gets back a short-lived token it passes to the LiveKit
// client SDK. The API key/secret never leave this server.
app.post('/token', async (req, res) => {
  const { room, identity } = req.body || {};
  if (!room || !identity) {
    return res.status(400).json({ error: 'room and identity are required' });
  }
  if (!LK_API_KEY || !LK_API_SECRET) {
    return res.status(500).json({ error: 'LiveKit credentials not configured on server' });
  }
  try {
    const at = new AccessToken(LK_API_KEY, LK_API_SECRET, {
      identity,
      ttl: '4h',
    });
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
    const token = await at.toJwt();
    res.json({ token });
  } catch (err) {
    console.error('token error', err.message);
    res.status(500).json({ error: 'failed to generate token' });
  }
});

// Create a new session → returns its 4-char code.
app.post('/session', (_req, res) => {
  const code = makeCode();
  const now = Date.now();
  sessions.set(code, { code, createdAt: now, lastSeen: now, paidCount: 0, openInvoices: [] });
  res.json({ code });
});

// Poll a session's status. Side-effect: checks LNbits for any open invoices and
// bumps paidCount for the ones that settled. This is how repeat payments are seen.
app.get('/session/:code', async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const session = sessions.get(code);
  if (!session) return res.json({ exists: false });

  session.lastSeen = Date.now();

  // Check each still-open invoice and count settled ones EXACTLY ONCE — even under
  // concurrent polls (multiple tabs/devices sharing the code, or overlapping poll
  // intervals). The count+removal is done synchronously AFTER the await, gated on
  // the invoice still being open: the first concurrent request to resolve removes
  // it and increments; any other request then sees idx === -1 and skips. Iterate a
  // snapshot so concurrent mutation of openInvoices is safe.
  for (const hash of [...session.openInvoices]) {
    let paid = false;
    try {
      paid = await lnbitsIsPaid(hash);
    } catch (err) {
      // Transient LNbits error — leave it open and retry on the next poll.
      console.error('check error', err.message);
      continue;
    }
    if (paid) {
      const idx = session.openInvoices.indexOf(hash); // still open?
      if (idx !== -1) {                               // first to see it wins
        session.openInvoices.splice(idx, 1);          // remove + count atomically
        session.paidCount += 1;                       // (no await between → no interleave)
        paymentToCode.delete(hash);
      }
    }
  }

  res.json({ exists: true, paidCount: session.paidCount });
});

// Create a 21-sat invoice tied to a session code.
app.post('/session/:code/invoice', async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ error: 'session not found' });

  try {
    const inv = await lnbitsCreateInvoice(INVOICE_AMOUNT, `Sats Arena rapid-fire (${code})`);
    session.openInvoices.push(inv.payment_hash);
    session.lastSeen = Date.now();
    paymentToCode.set(inv.payment_hash, code);
    res.json({ payment_hash: inv.payment_hash, payment_request: inv.payment_request });
  } catch (err) {
    console.error('invoice error', err.message);
    res.status(502).json({ error: 'failed to create invoice' });
  }
});

// ── TTL sweep ──────────────────────────────────────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [code, s] of sessions) {
    if (s.lastSeen < cutoff) {
      for (const hash of s.openInvoices) paymentToCode.delete(hash);
      sessions.delete(code);
    }
  }
}, SWEEP_MS);

app.listen(PORT, () => console.log(`Sats Arena backend listening on :${PORT}`));
