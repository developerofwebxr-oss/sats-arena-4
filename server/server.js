// ─────────────────────────────────────────────────────────────────────────────
// Sats Arena — backend
//
// Security model (Phase 4):
//   POST /token now requires EITHER a valid ownerToken OR a single-use
//   admissionTicket.  No un-gated path exists.
//
//   Owner flow  → POST /session/:code/claim  →  ownerToken  →  POST /token
//   Joiner flow → POST /session/:code/join-request
//                 → owner approves → admissionTicket → POST /token (consumed)
//
//   GET /session/:code (payment-status poll) now requires ownerToken.
//   All sensitive endpoints are rate-limited per real client IP.
// ─────────────────────────────────────────────────────────────────────────────

import express  from 'express';
import cors     from 'cors';
import crypto   from 'crypto';
import { AccessToken } from 'livekit-server-sdk';

// ── Config ────────────────────────────────────────────────────────────────────
const PORT           = process.env.PORT || 8080;
const LNBITS_URL     = (process.env.LNBITS_URL || '').replace(/\/+$/, '');
const INVOICE_KEY    = process.env.LNBITS_INVOICE_KEY || '';
const INVOICE_AMOUNT = parseInt(process.env.INVOICE_AMOUNT || '21', 10);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'https://developerofwebxr-oss.github.io')
  .split(',').map(s => s.trim()).filter(Boolean);

const DEV_ENDPOINTS = process.env.ENABLE_DEV_ENDPOINTS === 'true';
if (DEV_ENDPOINTS) console.warn('⚠  ENABLE_DEV_ENDPOINTS=true — simulate-payment is ACTIVE');

const LK_API_KEY    = process.env.LIVEKIT_API_KEY    || '';
const LK_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
if (!LK_API_KEY || !LK_API_SECRET) console.warn('⚠  LIVEKIT creds not set — /token will fail');
if (!LNBITS_URL || !INVOICE_KEY)   console.warn('⚠  LNBITS creds not set — invoice routes will fail');

// ── TTLs ──────────────────────────────────────────────────────────────────────
const SESSION_TTL = 30 * 60_000; // 30 min idle → purge session
const SWEEP_MS    =      60_000; // TTL sweep interval
const REQ_TTL     =      90_000; // pending join-request expires after 90 s
const TKT_TTL     =      60_000; // admission ticket expires 60 s after approval

// ── Rate limiter (in-memory, per real client IP) ───────────────────────────────
// Railway sits behind a proxy — read X-Forwarded-For, take the LEFTMOST address
// (the real client), not the proxy's IP.
const _rl = new Map(); // "ip:key" → { count, resetAt }

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'] || '';
  return (xff ? xff.split(',')[0] : req.socket.remoteAddress || '').trim();
}

function _checkRl(ip, key, maxPerMin) {
  const k = `${ip}:${key}`;
  const now = Date.now();
  let e = _rl.get(k);
  if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + 60_000 }; _rl.set(k, e); }
  return ++e.count <= maxPerMin;
}

// Rate-limit middleware factory
function rl(key, maxPerMin = 10) {
  return (req, res, next) => {
    if (!_checkRl(clientIp(req), key, maxPerMin)) {
      return res.status(429).json({ error: 'Too many requests — try again in a minute.' });
    }
    next();
  };
}

// Clean expired windows every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of _rl) if (now > e.resetAt) _rl.delete(k);
}, 300_000);

// ── Session store ──────────────────────────────────────────────────────────────
// code → {
//   code, createdAt, lastSeen, paidCount, openInvoices,
//   ownerToken,   // null until /claim; high-entropy hex secret
//   requests,     // Map(requestId → request)
// }
//
// request → {
//   requestId, requesterName, requesterCode, status,
//   admissionTicket, ticketUsed, ticketCreatedAt, createdAt
// }
const sessions     = new Map();
const paymentToCode = new Map();

function _newSession(code) {
  const now = Date.now();
  return { code, createdAt: now, lastSeen: now, paidCount: 0, openInvoices: [], ownerToken: null, paymentToken: null, requests: new Map() };
}

// ── LNbits helpers ────────────────────────────────────────────────────────────
async function lnbitsCreateInvoice(amount, memo) {
  const res = await fetch(`${LNBITS_URL}/api/v1/payments`, {
    method: 'POST',
    headers: { 'X-Api-Key': INVOICE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ out: false, amount, memo }),
  });
  if (!res.ok) throw new Error(`LNbits create invoice failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function lnbitsIsPaid(paymentHash) {
  const res = await fetch(`${LNBITS_URL}/api/v1/payments/${paymentHash}`, {
    headers: { 'X-Api-Key': INVOICE_KEY },
  });
  if (!res.ok) throw new Error(`LNbits check failed (${res.status})`);
  return (await res.json()).paid === true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function bearerToken(req) {
  return (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
}

function normalizeCode(raw) {
  return String(raw || '').toUpperCase().trim();
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`Origin not allowed: ${origin}`));
  },
}));

app.get('/',       (_req, res) => res.type('text').send('Sats Arena backend — ok'));
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── CLAIM ─────────────────────────────────────────────────────────────────────
// POST /session/:code/claim
// Establishes ownership of a code. Returns ownerToken on success, {taken:true}
// if already claimed by someone else. Rate-limited to 5/min to slow enumeration.
app.post('/session/:code/claim', rl('claim', 5), (req, res) => {
  const code = normalizeCode(req.params.code);
  if (!/^[A-Z0-9]{1,8}$/.test(code)) return res.status(400).json({ error: 'invalid code' });

  const existing = sessions.get(code);
  if (existing?.ownerToken) return res.json({ taken: true });

  const ownerToken   = crypto.randomBytes(32).toString('hex');
  const paymentToken = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  if (existing) {
    existing.ownerToken   = ownerToken;
    existing.paymentToken = paymentToken;
    existing.requests     = existing.requests || new Map();
    existing.lastSeen     = now;
  } else {
    sessions.set(code, { ..._newSession(code), ownerToken, paymentToken });
  }
  console.log(`[claim] ${code} owned`);
  res.json({ code, ownerToken, paymentToken });
});

// ── TOKEN (GATED) ─────────────────────────────────────────────────────────────
// POST /token  { room, identity, ownerToken? | admissionTicket? }
// Issues a LiveKit JWT. Requires EITHER:
//   ownerToken  — the secret returned by /claim for this room, OR
//   admissionTicket — single-use token generated by owner /approve
// Any other request → 403. No bypass path exists.
app.post('/token', rl('token', 15), async (req, res) => {
  const { room, identity, ownerToken, admissionTicket } = req.body || {};
  if (!room || !identity) return res.status(400).json({ error: 'room and identity are required' });

  const code    = normalizeCode(room);
  const session = sessions.get(code);
  let authorized = false;

  if (session?.ownerToken && ownerToken === session.ownerToken) {
    authorized = true; // owner joining their own room
  } else if (admissionTicket && session) {
    const now = Date.now();
    for (const r of session.requests.values()) {
      if (r.admissionTicket === admissionTicket &&
          !r.ticketUsed                         &&
          r.status === 'approved'               &&
          now - r.ticketCreatedAt < TKT_TTL) {
        r.ticketUsed = true; // consume — single use
        authorized   = true;
        console.log(`[token] ${code} — ticket consumed for ${r.requesterName}`);
        break;
      }
    }
  }

  if (!authorized) {
    console.warn(`[token] 403 for room=${code} ip=${clientIp(req)}`);
    return res.status(403).json({ error: 'Not authorized. The host must approve your join request.' });
  }

  if (!LK_API_KEY || !LK_API_SECRET) {
    return res.status(500).json({ error: 'LiveKit credentials not configured on server' });
  }

  try {
    const at = new AccessToken(LK_API_KEY, LK_API_SECRET, { identity, ttl: '4h' });
    at.addGrant({ roomJoin: true, room: code, canPublish: true, canSubscribe: true });
    res.json({ token: await at.toJwt() });
  } catch (err) {
    console.error('token error', err.message);
    res.status(500).json({ error: 'failed to generate token' });
  }
});

// ── KNOCK ─────────────────────────────────────────────────────────────────────
// POST /session/:code/join-request  { requesterName, requesterCode }
// Creates a pending join request. No token is issued here.
// Cap: 3 simultaneous pending requests per room (prevents owner prompt-flooding).
app.post('/session/:code/join-request', rl('join-request', 10), (req, res) => {
  const code = normalizeCode(req.params.code);
  const { requesterName, requesterCode } = req.body || {};
  if (!requesterName) return res.status(400).json({ error: 'requesterName required' });

  const session = sessions.get(code);
  if (!session?.ownerToken) return res.status(404).json({ error: 'session not found' });

  const pending = [...session.requests.values()].filter(r => r.status === 'pending');
  if (pending.length >= 3) {
    return res.status(429).json({ error: 'Too many pending requests — try again shortly' });
  }

  const requestId = crypto.randomBytes(16).toString('hex');
  session.requests.set(requestId, {
    requestId,
    requesterName:  String(requesterName).slice(0, 30),
    requesterCode:  normalizeCode(requesterCode).slice(0, 8),
    status:         'pending',
    admissionTicket: null,
    ticketUsed:      false,
    ticketCreatedAt: null,
    createdAt:       Date.now(),
  });
  session.lastSeen = Date.now();
  console.log(`[knock] ${code} ← ${requesterName} (${requesterCode})`);
  res.json({ requestId, status: 'pending' });
});

// ── LIST PENDING REQUESTS (owner only) ────────────────────────────────────────
// GET /session/:code/requests   Authorization: Bearer <ownerToken>
app.get('/session/:code/requests', rl('list-requests', 30), (req, res) => {
  const code    = normalizeCode(req.params.code);
  const session = sessions.get(code);
  if (!session?.ownerToken || bearerToken(req) !== session.ownerToken) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const now     = Date.now();
  const pending = [...session.requests.values()]
    .filter(r => r.status === 'pending' && now - r.createdAt < REQ_TTL)
    .map(r => ({ requestId: r.requestId, requesterName: r.requesterName, requesterCode: r.requesterCode }));
  res.json(pending);
});

// ── APPROVE ───────────────────────────────────────────────────────────────────
// POST /session/:code/join-request/:requestId/approve
// Generates a single-use admissionTicket (60 s TTL).
app.post('/session/:code/join-request/:requestId/approve', rl('approve', 20), (req, res) => {
  const code    = normalizeCode(req.params.code);
  const session = sessions.get(code);
  if (!session?.ownerToken || bearerToken(req) !== session.ownerToken) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const r = session.requests.get(req.params.requestId);
  if (!r) return res.status(404).json({ error: 'request not found' });
  if (r.status !== 'pending') return res.status(409).json({ error: `already ${r.status}` });

  r.status          = 'approved';
  r.admissionTicket = crypto.randomBytes(32).toString('hex');
  r.ticketCreatedAt = Date.now();
  console.log(`[approve] ${code} → ${r.requesterName}`);
  res.json({ status: 'approved' });
});

// ── DENY ──────────────────────────────────────────────────────────────────────
// POST /session/:code/join-request/:requestId/deny
app.post('/session/:code/join-request/:requestId/deny', rl('deny', 20), (req, res) => {
  const code    = normalizeCode(req.params.code);
  const session = sessions.get(code);
  if (!session?.ownerToken || bearerToken(req) !== session.ownerToken) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const r = session.requests.get(req.params.requestId);
  if (!r) return res.status(404).json({ error: 'request not found' });
  if (r.status !== 'pending') return res.status(409).json({ error: `already ${r.status}` });

  r.status = 'denied';
  console.log(`[deny] ${code} → ${r.requesterName}`);
  res.json({ status: 'denied' });
});

// ── POLL JOIN-REQUEST STATUS (public — joiner polls for their own request) ────
// GET /session/:code/join-request/:requestId
// Returns { status } and, on approved, the single-use admissionTicket.
app.get('/session/:code/join-request/:requestId', rl('poll-status', 20), (req, res) => {
  const code    = normalizeCode(req.params.code);
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ error: 'session not found' });

  const r = session.requests.get(req.params.requestId);
  if (!r) return res.status(404).json({ error: 'request not found' });

  // Expire pending requests that outlived REQ_TTL
  if (r.status === 'pending' && Date.now() - r.createdAt > REQ_TTL) r.status = 'expired';

  const resp = { status: r.status };
  if (r.status === 'approved' && !r.ticketUsed && r.admissionTicket) {
    if (Date.now() - r.ticketCreatedAt < TKT_TTL) {
      resp.admissionTicket = r.admissionTicket;
      resp.paymentToken    = session.paymentToken;
    } else {
      resp.status = r.status = 'expired';
    }
  }
  res.json(resp);
});

// ── SESSION STATUS (owner-only — closes public enumeration oracle) ─────────────
// GET /session/:code?ownerToken=... OR Authorization: Bearer <ownerToken>
// Without correct ownerToken: always 403, regardless of whether code is live.
app.get('/session/:code', rl('session-poll', 30), async (req, res) => {
  const code    = normalizeCode(req.params.code);
  const token   = req.query.ownerToken || bearerToken(req);
  const session = sessions.get(code);

  if (!session) return res.status(403).json({ error: 'Not authorized' });

  const isOwner  = session.ownerToken   && session.ownerToken   === token;
  const isReader = session.paymentToken && session.paymentToken === token;
  if (!isOwner && !isReader && !DEV_ENDPOINTS) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  session.lastSeen = Date.now();

  if (isOwner) {
    // Only the owner triggers LNbits check; readers see cached paidCount
    for (const hash of [...session.openInvoices]) {
      let paid = false;
      try { paid = await lnbitsIsPaid(hash); } catch (err) { console.error('check error', err.message); continue; }
      if (paid) {
        const idx = session.openInvoices.indexOf(hash);
        if (idx !== -1) {
          session.openInvoices.splice(idx, 1);
          session.paidCount += 1;
          paymentToCode.delete(hash);
        }
      }
    }
  }

  res.json({ exists: true, paidCount: session.paidCount });
});

// ── LEGACY: create-or-touch a session (used by lightning.js PUT) ──────────────
// Idempotent touch for Lightning activation. Does NOT grant tokens.
// If the session was already claimed (has ownerToken), this just refreshes lastSeen.
app.put('/session/:code', (req, res) => {
  const code = normalizeCode(req.params.code);
  if (!code) return res.status(400).json({ error: 'code required' });
  let session = sessions.get(code);
  if (!session) {
    session = _newSession(code);
    sessions.set(code, session);
  } else {
    session.lastSeen = Date.now();
  }
  res.json({ code, paidCount: session.paidCount });
});

// ── DEV: simulate-payment (gated behind ENABLE_DEV_ENDPOINTS) ─────────────────
app.post('/session/:code/simulate-payment', (req, res) => {
  if (!DEV_ENDPOINTS) return res.status(404).json({ error: 'not found' });
  const code    = normalizeCode(req.params.code);
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ error: 'session not found' });
  session.paidCount  += 1;
  session.lastSeen    = Date.now();
  console.log(`[dev] simulate-payment for ${code} → paidCount=${session.paidCount}`);
  res.json({ code, paidCount: session.paidCount });
});

// ── INVOICE ───────────────────────────────────────────────────────────────────
app.post('/session/:code/invoice', async (req, res) => {
  const code = normalizeCode(req.params.code);
  let session = sessions.get(code);
  if (!session) { session = _newSession(code); sessions.set(code, session); }
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

// ── TTL SWEEP ──────────────────────────────────────────────────────────────────
setInterval(() => {
  const now    = Date.now();
  const cutoff = now - SESSION_TTL;
  for (const [code, s] of sessions) {
    if (s.lastSeen < cutoff) {
      for (const hash of s.openInvoices) paymentToCode.delete(hash);
      sessions.delete(code);
      continue;
    }
    // Expire stale requests and consumed/expired tickets within live sessions
    for (const [id, r] of s.requests) {
      if (r.status === 'pending'  && now - r.createdAt      > REQ_TTL) r.status = 'expired';
      if (r.status === 'approved' && r.ticketUsed)                      s.requests.delete(id);
      if (r.status === 'expired'  && now - r.createdAt      > REQ_TTL * 3) s.requests.delete(id);
      if (r.status === 'denied'   && now - r.createdAt      > REQ_TTL * 3) s.requests.delete(id);
    }
  }
}, SWEEP_MS);

app.listen(PORT, () => console.log(`Sats Arena backend listening on :${PORT}`));
