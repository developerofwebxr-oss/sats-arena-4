/**
 * coop-hud.js — Co-op session panel (join by numeric code).
 *
 * Security model (Phase 4):
 *   On load: claim own code → get ownerToken → auto-join own room (owner path).
 *   To join friend: POST /join-request → poll until approved → get admissionTicket
 *   → POST /token (ticket consumed, single-use) → join LiveKit room (knock path).
 *   For BC/Mock transport: no server approval required (dev/local only).
 *
 * ownerToken is held in memory only, never in localStorage or the DOM.
 */

import {
  joinSession,
  leaveSession,
  onPeerJoin,
  onPeerLeave,
  getParticipantCount,
  getRoomName,
  setMicEnabled,
  isMicEnabled,
  onMicStateChange,
  getActiveTransportType,
} from './room.js';
import {
  isLightningEnabled,
  activateWithCode,
  deactivate as deactivateLightning,
  getBackendUrl,
  setOwnerToken,
  setPaymentToken,
} from '../lightning.js';

let panel, codeInput, nameInput, joinBtn, statusEl, countEl, codeDisplay, muteBtn;
let sessionChip;
let currentMode  = 'flat';
let joined       = false;
// NOTE: there is deliberately no local `muted` boolean. The mute control reads
// the REAL publish state from LiveKit (isMicEnabled()); a shadow copy is exactly
// what made the old button claim "MUTE" while the mic was never published.
let ownCode      = null; // this device's own code (never changes after load)
let ownerToken   = null; // secret returned by /claim; held in memory only
let _ownerPollTimer = null; // timer for polling pending join requests
let _pending     = [];   // last pending join-request list (mirrored to the VR menu)
let _pendingCbs  = [];   // subscribers notified whenever that list changes

// Called from main.js when the XR mode changes.
export function setCoopMode(mode) {
  currentMode = mode; // 'flat' | 'vr' | 'ar'
}

// This device's own claimed code (the room it owns). Competition uses it to
// decide the host/authority: you are the host iff getRoomName() === getOwnCode()
// (the owner auto-joins their OWN code; a joiner is in the friend's code).
export function getOwnCode() { return ownCode; }

// Mute state for any non-DOM view (the in-world VR/AR menu on the staging
// branch reads this). Derived from the REAL publish state, so the in-world row
// and the DOM button can never disagree — neither keeps its own boolean.
export function isCoopMuted() { return !isMicEnabled(); }

// This device's display name (for competition proposal cards).
export function getLocalName() {
  return localStorage.getItem('coopName') || (nameInput && nameInput.value) || 'Player';
}

export function setupCoopHud() {
  injectStyles();

  const toggle = document.createElement('button');
  toggle.id = 'coop-toggle';
  toggle.textContent = '👥 CO-OP';
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  });
  document.body.appendChild(toggle);

  panel = document.createElement('div');
  panel.id = 'coop-panel';
  panel.style.display = 'none';

  panel.innerHTML = `
    <button id="coop-close" aria-label="Close">✕</button>
    <div id="coop-title">CO-OP SESSION</div>
    <div class="coop-row">
      <label class="coop-label">FRIEND'S CODE</label>
      <input id="coop-code" type="text" inputmode="text" autocapitalize="characters"
             maxlength="8" placeholder="Enter friend's code" autocomplete="off" spellcheck="false" />
      <div class="coop-hint">Your code's up top. Enter a friend's code to connect and play together.</div>
    </div>
    <div class="coop-row">
      <label class="coop-label">YOUR NAME</label>
      <input id="coop-name" type="text" maxlength="20" placeholder="Player" autocomplete="off" />
    </div>
    <div class="coop-btn-row">
      <button id="coop-join">JOIN</button>
      <button id="coop-leave" style="display:none">LEAVE</button>
      <button id="coop-mute" style="display:none">🎙 MUTE</button>
    </div>
    <div id="coop-status"></div>
    <div id="coop-active" style="display:none">
      <div id="coop-code-display"></div>
      <div id="coop-count">Players: 1</div>
    </div>
    <div id="coop-requests"></div>
  `;

  document.body.appendChild(panel);

  sessionChip = document.createElement('div');
  sessionChip.id = 'session-chip';
  sessionChip.style.cssText = `
    position: fixed; top: 16px; left: 16px; z-index: 8000;
    font: 700 13px/1 monospace; letter-spacing: .18em;
    color: #7df; text-shadow: 0 0 8px #7df;
    pointer-events: none; user-select: none; display: none;
  `;
  document.body.appendChild(sessionChip);

  codeInput   = panel.querySelector('#coop-code');
  nameInput   = panel.querySelector('#coop-name');
  joinBtn     = panel.querySelector('#coop-join');
  statusEl    = panel.querySelector('#coop-status');
  countEl     = panel.querySelector('#coop-count');
  codeDisplay = panel.querySelector('#coop-code-display');
  muteBtn     = panel.querySelector('#coop-mute');
  const leaveBtn = panel.querySelector('#coop-leave');
  const closeBtn = panel.querySelector('#coop-close');

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.style.display = 'none';
  });
  document.addEventListener('click', () => {
    if (panel.style.display !== 'none') panel.style.display = 'none';
  });
  panel.addEventListener('click', (e) => e.stopPropagation());

  nameInput.value = localStorage.getItem('coopName') || '';

  codeInput.addEventListener('input', () => {
    const pos = codeInput.selectionStart;
    codeInput.value = codeInput.value.toUpperCase();
    codeInput.setSelectionRange(pos, pos);
  });

  // On load: claim own code → store ownerToken → start owner polling immediately
  // (decoupled from room join) → then auto-join own LiveKit room.
  // Polling and chip are live from the moment of claim — room join failure is
  // non-fatal (host can still approve/deny; they just won't have presence/audio).
  _claimUniqueCode().then(async ({ code, ownerToken: tok }) => {
    ownCode    = code;
    ownerToken = tok;
    _updateChip(code);
    setOwnerToken(tok);

    // Start polling BEFORE auto-join so knock requests are visible even if
    // the room connection is slow or temporarily fails.
    _startOwnerPolling();

    if (!tok) return; // claim failed after retries — chip-only mode, no /token call

    const savedName = localStorage.getItem('coopName') || nameInput.value || 'Player';
    try {
      await joinSession(code, { name: savedName, mode: currentMode, ownerToken: tok });
      joined = true;
      // The host auto-joins their OWN room, which previously skipped showJoined()
      // entirely — so the host had no mute control on their own device. Surface
      // just the mute button; the JOIN row stays available so the host can still
      // join a friend's code.
      showMuteControl();
      if (isLightningEnabled()) activateWithCode(code);
    } catch (e) {
      console.warn('[coop] auto-join own room failed', e);
      // Polling continues — host can still approve/deny
    }
  });

  joinBtn.addEventListener('click', handleJoin);
  leaveBtn.addEventListener('click', handleLeave);
  muteBtn.addEventListener('click', handleMute);

  // Repaint from the transport's own truth whenever it changes (publish,
  // unpublish, mute, unmute, or the room going away).
  onMicStateChange(() => _refreshMuteBtn());

  onPeerJoin((identity, displayName) => {
    setStatus(`${displayName} joined`, 'ok');
    refreshCount();
  });
  onPeerLeave((identity) => {
    setStatus('A player left', 'warn');
    refreshCount();
  });
}

// ── Code alphabet — uppercase, visually unambiguous (no 0/O/1/I/L) ─────────────
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function _randomCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

// Claim a unique code via POST /session/:code/claim. Retries with backoff until
// a code is successfully owned. Falls back to null ownerToken only after 30 failed
// attempts (server permanently down), so the chip still shows.
async function _claimUniqueCode() {
  const backend = getBackendUrl();
  let delay = 0;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    const candidate = _randomCode();
    try {
      const res = await fetch(`${backend}/session/${candidate}/claim`, { method: 'POST' });
      if (!res.ok) { delay = Math.min((delay || 1000) + 1000, 6000); continue; }
      const data = await res.json();
      if (!data.taken) return { code: candidate, ownerToken: data.ownerToken };
      // Code already claimed — try a different candidate without delay
    } catch {
      // Network error (cold start, flaky connection) — back off and retry
      delay = Math.min((delay || 1000) * 2, 8000);
    }
  }
  console.warn('[coop] claim failed after 30 attempts — chip-only mode');
  return { code: _randomCode(), ownerToken: null };
}

function _updateChip(code) {
  if (code && /^[A-Z0-9]{1,8}$/.test(code)) {
    sessionChip.textContent = `SESSION ${code}`;
    sessionChip.style.display = 'block';
  } else {
    sessionChip.style.display = 'none';
  }
}

// ── JOIN handler ──────────────────────────────────────────────────────────────
// BC/Mock transports: join directly (no server approval — dev-only paths).
// LiveKit: knock flow — POST /join-request → poll → approved ticket → /token.
async function handleJoin() {
  const code = codeInput.value.trim().toUpperCase();
  const name = nameInput.value.trim() || 'Player';

  if (!code || !/^[A-Z0-9]{1,8}$/.test(code)) {
    setStatus("Enter your friend's code", 'err');
    return;
  }

  localStorage.setItem('coopName', name);
  joinBtn.disabled = true;

  if (getActiveTransportType() !== 'livekit') {
    // BC / Mock — no server gating; join directly for local dev
    setStatus('Connecting…', '');
    try {
      await joinSession(code, { name, mode: currentMode });
      joined = true;
      showJoined(code);
      setStatus('Connected!', 'ok');
      refreshCount();
      if (isLightningEnabled()) activateWithCode(code);
    } catch (err) {
      console.error('[coop]', err);
      setStatus(err.message, 'err');
      joinBtn.disabled = false;
    }
    return;
  }

  // LiveKit — knock flow
  setStatus(`Requesting to join ${code}…`, '');
  try {
    const backend   = getBackendUrl();
    const knockRes  = await fetch(`${backend}/session/${code}/join-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterName: name, requesterCode: ownCode }),
    });

    if (!knockRes.ok) {
      const err = await knockRes.json().catch(() => ({}));
      throw new Error(err.error || `Knock failed (${knockRes.status})`);
    }

    const { requestId } = await knockRes.json();
    setStatus(`Waiting for ${code} to approve… (90 s)`, '');

    const { admissionTicket, paymentToken } = await _pollForApproval(code, requestId);

    setStatus('Connecting…', '');
    await joinSession(code, { name, mode: currentMode, admissionTicket });
    joined = true;
    showJoined(code);
    setStatus('Connected!', 'ok');
    refreshCount();
    if (isLightningEnabled()) {
      if (paymentToken) setPaymentToken(paymentToken);
      activateWithCode(code);
    }
  } catch (err) {
    console.error('[coop]', err);
    const msg = err.message || '';
    // Map low-level errors to user-friendly messages so "Token fetch failed: 403"
    // never reaches the user — that would indicate a bypass of the knock flow.
    const friendly = /403|Token fetch|Not authorized/i.test(msg) ? 'Could not connect — check the code and try again'
                   : /404|not found/i.test(msg)                  ? 'Session not found — check the code'
                   : /denied/i.test(msg)                         ? 'Request declined'
                   : /timed out|expired/i.test(msg)              ? 'Request timed out — try again'
                   : msg;
    setStatus(friendly, 'err');
    joinBtn.disabled = false;
  }
}

// Poll GET /session/:code/join-request/:requestId until approved or terminal.
// Returns the admissionTicket on approval; throws on denial/expiry/timeout.
async function _pollForApproval(friendCode, requestId, timeoutMs = 90_000) {
  const backend  = getBackendUrl();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));

    const res = await fetch(`${backend}/session/${friendCode}/join-request/${requestId}`);
    if (!res.ok) throw new Error('Request status check failed');
    const data = await res.json();

    if (data.status === 'approved') {
      if (!data.admissionTicket) throw new Error('Approved but no ticket received');
      return { admissionTicket: data.admissionTicket, paymentToken: data.paymentToken || null };
    }
    if (data.status === 'denied')  throw new Error('Join request was denied');
    if (data.status === 'expired') throw new Error('Join request timed out');
  }

  throw new Error('Timed out waiting for host approval');
}

// ── OWNER POLLING — shows incoming knock requests in the panel ─────────────────
function _startOwnerPolling() {
  if (getActiveTransportType() !== 'livekit') return; // BC/Mock — no server
  if (_ownerPollTimer) return;
  const backend = getBackendUrl();
  const poll = async () => {
    if (!ownCode || !ownerToken) return;
    try {
      const res = await fetch(`${backend}/session/${ownCode}/requests`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      if (res.ok) _renderPendingRequests(await res.json());
    } catch { /* transient */ }
    _ownerPollTimer = setTimeout(poll, 4000);
  };
  _ownerPollTimer = setTimeout(poll, 2000);
}

function _stopOwnerPolling() {
  if (_ownerPollTimer) { clearTimeout(_ownerPollTimer); _ownerPollTimer = null; }
  _renderPendingRequests([]); // clear any shown cards
}

// Render / diff incoming request cards inside #coop-requests.
// Also manages a red badge on the toggle button so the host knows someone
// is knocking even when the panel is closed.
function _renderPendingRequests(list) {
  // Mirror the pending list to any non-DOM view (the in-world VR/AR menu).
  // Done before the DOM guard so the headset host still sees knocks even if the
  // co-op panel isn't built yet. DOM rendering below is unchanged.
  _pending = Array.isArray(list) ? list : [];
  _pendingCbs.forEach((fn) => { try { fn(_pending); } catch (e) { console.warn('[coop] pending cb', e); } });

  const container = panel.querySelector('#coop-requests');
  if (!container) return;

  // Badge on the CO-OP toggle button
  const toggle = document.getElementById('coop-toggle');
  if (toggle) {
    const existing = toggle.querySelector('.coop-badge');
    if (list.length > 0 && !existing) {
      const b = document.createElement('span');
      b.className = 'coop-badge';
      toggle.appendChild(b);
    } else if (list.length === 0 && existing) {
      existing.remove();
    }
  }

  const seen = new Set(list.map(r => r.requestId));

  // Remove cards for requests no longer pending
  for (const card of [...container.querySelectorAll('.coop-req')]) {
    if (!seen.has(card.dataset.id)) card.remove();
  }

  // Add new cards
  for (const r of list) {
    if (container.querySelector(`[data-id="${r.requestId}"]`)) continue;
    const card = document.createElement('div');
    card.className = 'coop-req';
    card.dataset.id = r.requestId;
    card.innerHTML = `
      <span class="req-info">
        <span class="req-name">${_esc(r.requesterName)}</span>
        <span class="req-code">${_esc(r.requesterCode)}</span>
        wants to join
      </span>
      <span class="req-btns">
        <button class="req-approve" title="Approve">✓</button>
        <button class="req-deny"    title="Deny">✗</button>
      </span>
    `;
    card.querySelector('.req-approve').addEventListener('click', async (e) => {
      e.stopPropagation();
      card.remove();
      await _approveRequest(r.requestId);
    });
    card.querySelector('.req-deny').addEventListener('click', async (e) => {
      e.stopPropagation();
      card.remove();
      await _denyRequest(r.requestId);
    });
    container.appendChild(card);
  }
}

async function _approveRequest(requestId) {
  const backend = getBackendUrl();
  try {
    await fetch(`${backend}/session/${ownCode}/join-request/${requestId}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
  } catch (e) { console.warn('[coop] approve failed', e); }
}

async function _denyRequest(requestId) {
  const backend = getBackendUrl();
  try {
    await fetch(`${backend}/session/${ownCode}/join-request/${requestId}/deny`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
  } catch (e) { console.warn('[coop] deny failed', e); }
}

function _esc(str) {
  return String(str || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ── In-world (VR/AR) accessors ────────────────────────────────────────────────
// The immersive menu has no DOM, so it calls these. Each one delegates to the
// SAME handler the DOM button uses — no duplicated logic, no new mechanics.

/** Fire the LEAVE action (identical to clicking #coop-leave). */
export function coopLeave() { return handleLeave(); }

/** Toggle mic mute (identical to clicking #coop-mute). Keeps the DOM label in sync. */
export function coopToggleMute() { return handleMute(); }

/** Current mute state, so the in-world item can render MUTE vs UNMUTE. */
export function isCoopMuted() { return muted; }

/** True once this device is in a room (the DOM shows LEAVE/MUTE at the same time). */
export function isCoopJoined() { return joined; }

/** Subscribe to pending join requests. Fires immediately with the current list. */
export function onPendingRequests(cb) {
  _pendingCbs.push(cb);
  cb(_pending);
}

/** Approve a knock by id (identical to the DOM card's ✓ button). */
export function approveJoinRequest(requestId) { return _approveRequest(requestId); }

/** Deny a knock by id (identical to the DOM card's ✗ button). */
export function denyJoinRequest(requestId) { return _denyRequest(requestId); }

// ── LEAVE / MUTE ───────────────────────────────────────────────────────────────
async function handleLeave() {
  _stopOwnerPolling();
  await leaveSession();
  joined = false;
  showDisconnected();
  setStatus('Left session', '');
  if (isLightningEnabled()) deactivateLightning();
}

async function handleMute() {
  // ONE PRESS to go live. We toggle against the REAL publish state, so the first
  // press on a freshly joined (muted) session publishes the mic — the old code
  // toggled a local boolean that started out disagreeing with reality, which
  // cost two presses and showed the wrong label the whole time.
  const live = isMicEnabled();
  muteBtn.disabled = true;           // no double-fire while getUserMedia resolves
  try {
    await setMicEnabled(!live);
  } catch (e) {
    // Almost always a denied/unavailable microphone permission.
    console.warn('[coop] mic toggle failed', e);
    setStatus('Microphone unavailable — check permissions', 'err');
  } finally {
    muteBtn.disabled = false;
    _refreshMuteBtn();               // repaint from real state, never from a guess
  }
}

// Repaint the mute button from the REAL mic state. Called after every toggle and
// from onMicStateChange, so the label can never drift from what is published.
//   not transmitting → "🎙 TALK"  (press to go live)
//   transmitting     → "🔴 MUTE"  (red dot = you are broadcasting right now)
function _refreshMuteBtn() {
  if (!muteBtn) return;
  const live = isMicEnabled();
  muteBtn.textContent = live ? '🔴 MUTE' : '🎙 TALK';
  muteBtn.title = live
    ? 'Your mic is live — click to mute'
    : 'Your mic is off — click to talk';
  muteBtn.classList.toggle('mic-live', live);
}

// Show the mute control on this device. Split out of showJoined() because the
// HOST auto-joins their OWN room and must keep the JOIN button available to
// also join a friend's code — so the host gets the mute control WITHOUT the
// rest of showJoined()'s "you are a guest in someone's room" layout.
function showMuteControl() {
  if (!muteBtn) return;
  muteBtn.style.display = 'inline-block';
  _refreshMuteBtn();
}

function showJoined(code) {
  panel.querySelector('#coop-join').style.display  = 'none';
  panel.querySelector('#coop-leave').style.display = 'inline-block';
  showMuteControl();
  panel.querySelector('#coop-active').style.display = 'block';
  codeDisplay.textContent = `CODE: ${code}`;
  _updateChip(code);
}

function showDisconnected() {
  joinBtn.style.display  = 'inline-block';
  joinBtn.disabled = false;
  panel.querySelector('#coop-leave').style.display = 'none';
  muteBtn.style.display = 'none';
  panel.querySelector('#coop-active').style.display = 'none';
  _refreshMuteBtn(); // leave() drops the room → real state is already "not live"
  if (ownCode) _updateChip(ownCode);
}

function refreshCount() {
  const n = getParticipantCount();
  countEl.textContent = `Players: ${n}`;
}

function setStatus(msg, level) {
  statusEl.textContent = msg;
  statusEl.className = level === 'err' ? 'coop-err' : level === 'ok' ? 'coop-ok' : '';
}

function injectStyles() {
  const s = document.createElement('style');
  s.textContent = `
    #coop-toggle {
      position: fixed;
      bottom: 16px;
      left: 16px;
      z-index: 9000;
      background: rgba(0,0,0,0.75);
      color: #7df;
      border: 1px solid #7df;
      border-radius: 6px;
      padding: 8px 14px;
      font: 700 13px/1 monospace;
      cursor: pointer;
      letter-spacing: .08em;
    }
    #coop-toggle:hover { background: rgba(0,120,180,0.4); }
    /* Red dot alert when someone is knocking and the panel is closed */
    .coop-badge {
      position: absolute; top: -5px; right: -5px;
      width: 10px; height: 10px; border-radius: 50%;
      background: #f44; border: 1.5px solid #111;
      animation: coop-pulse 1.2s ease-in-out infinite;
    }
    @keyframes coop-pulse {
      0%,100% { transform: scale(1); opacity: 1; }
      50%      { transform: scale(1.35); opacity: .7; }
    }
    /* Mobile only: place CO-OP in the gap between RECENTER and SCREEN/VR/AR row,
       centered horizontally over the SCREEN button (left third of mode switcher).
       RECENTER has an inline bottom:90px so we need !important to push it up. */
    @media (max-width: 480px) {
      #recenter-btn { bottom: 110px !important; }
      #coop-toggle  {
        bottom: 73px;
        left: calc((100vw - min(calc(100vw - 28px), 360px)) / 2);
        width: calc((min(calc(100vw - 28px), 360px) - 12px) / 3);
        box-sizing: border-box;
        text-align: center;
      }
      #coop-panel { bottom: 112px; }
    }

    #coop-panel {
      position: fixed;
      bottom: 54px;
      left: 16px;
      z-index: 9000;
      background: rgba(0,0,0,0.88);
      border: 1px solid #7df;
      border-radius: 10px;
      padding: 14px 16px 12px;
      width: 240px;
      flex-direction: column;
      gap: 10px;
      font-family: monospace;
      color: #ddf;
    }
    #coop-title {
      font: 700 12px/1 monospace;
      letter-spacing: .15em;
      color: #7df;
      margin-bottom: 2px;
      padding-right: 20px;
    }
    #coop-close {
      position: absolute;
      top: 10px;
      right: 10px;
      background: none;
      border: none;
      color: #7df;
      font: 700 15px/1 monospace;
      cursor: pointer;
      padding: 2px 5px;
      opacity: 0.6;
      z-index: 1;
    }
    #coop-close:hover { opacity: 1; }
    .coop-row { display: flex; flex-direction: column; gap: 4px; }
    .coop-label { font-size: 10px; letter-spacing: .12em; color: #7df; opacity:.7; }
    .coop-hint { font-size: 9px; color: #7df; opacity: .55; letter-spacing: .03em; }

    #coop-panel input {
      background: rgba(255,255,255,0.07);
      border: 1px solid #7df6;
      border-radius: 5px;
      color: #eef;
      font: 15px monospace;
      padding: 6px 8px;
      width: 100%;
      box-sizing: border-box;
      letter-spacing: .08em;
    }
    #coop-code::placeholder { font-size: 11px; letter-spacing: .03em; }
    .coop-btn-row { display: flex; gap: 8px; align-items: center; }
    #coop-join, #coop-leave {
      flex: 1;
      padding: 8px 0;
      border-radius: 6px;
      border: none;
      font: 700 12px monospace;
      letter-spacing: .1em;
      cursor: pointer;
    }
    #coop-join { background: #7df; color: #003; }
    #coop-join:disabled { opacity: .5; cursor: default; }
    #coop-leave { background: #433; color: #faa; border: 1px solid #f66; }
    #coop-mute  {
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid #7df6;
      background: rgba(0,0,0,.5);
      color: #adf;
      font: 12px monospace;
      cursor: pointer;
    }
    /* Live mic: red border + glow, so "you are broadcasting" is readable at a
       glance and not carried by the label text alone. */
    #coop-mute.mic-live {
      border-color: #ff5d6c;
      color: #ff9aa4;
      background: rgba(255,93,108,.12);
      text-shadow: 0 0 8px #ff5d6c66;
    }
    #coop-mute:disabled { opacity: .55; cursor: default; }
    #coop-status { font-size: 11px; min-height: 14px; }
    .coop-err { color: #f88; }
    .coop-ok  { color: #8f8; }
    #coop-active { border-top: 1px solid #7df3; padding-top: 8px; }
    #coop-code-display {
      font: 700 18px monospace;
      letter-spacing: .2em;
      color: #ffe;
      text-align: center;
    }
    #coop-count { font-size: 11px; color: #adf; text-align: center; margin-top: 4px; }

    /* Knock / approval cards */
    #coop-requests:not(:empty) {
      border-top: 1px solid #7df3;
      padding-top: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .coop-req {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(100,200,255,0.08);
      border: 1px solid #7df5;
      border-radius: 6px;
      padding: 5px 8px;
      gap: 6px;
    }
    .req-info { font-size: 10px; color: #cef; line-height: 1.3; flex: 1; }
    .req-name { font-weight: 700; color: #7df; display: block; }
    .req-code { font-size: 9px; opacity: .7; }
    .req-btns { display: flex; gap: 4px; flex-shrink: 0; }
    .req-approve, .req-deny {
      border: none;
      border-radius: 4px;
      font: 700 12px monospace;
      cursor: pointer;
      padding: 3px 7px;
    }
    .req-approve { background: #3a6; color: #fff; }
    .req-approve:hover { background: #4c8; }
    .req-deny    { background: #633; color: #faa; }
    .req-deny:hover { background: #855; }
  `;
  document.head.appendChild(s);
}
