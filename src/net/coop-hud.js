/**
 * coop-hud.js — Co-op session panel (join by numeric code).
 *
 * Completely independent of the existing HUD. Creates a slide-out panel at
 * the bottom-left. Calls room.js for all networking.
 */

import {
  joinSession,
  leaveSession,
  onPeerJoin,
  onPeerLeave,
  getParticipantCount,
  getRoomName,
  setMicEnabled,
} from './room.js';
import { isLightningEnabled, activateWithCode, deactivate as deactivateLightning, getBackendUrl } from '../lightning.js';

let panel, codeInput, nameInput, joinBtn, statusEl, countEl, codeDisplay, muteBtn;
let sessionChip; // fixed top-left chip showing SESSION ####
let currentMode = 'flat';
let joined = false;
let muted = false;
let ownCode = null; // this device's own generated code (never changes after load)

// Called from main.js when the XR mode changes.
export function setCoopMode(mode) {
  currentMode = mode; // 'flat' | 'vr' | 'ar'
}

export function setupCoopHud() {
  injectStyles();

  // Toggle button (always visible, bottom-left)
  const toggle = document.createElement('button');
  toggle.id = 'coop-toggle';
  toggle.textContent = '👥 CO-OP';
  toggle.addEventListener('click', (e) => {
    e.stopPropagation(); // don't let the click bubble to the tap-outside handler
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  });
  document.body.appendChild(toggle);

  // Panel
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
  `;

  document.body.appendChild(panel);

  // Persistent SESSION chip — top-left, shown only while joined.
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
  const leaveBtn  = panel.querySelector('#coop-leave');
  const closeBtn  = panel.querySelector('#coop-close');

  // Close X — hides the panel without leaving the session.
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.style.display = 'none';
  });

  // Tap outside the panel to close it (panel click doesn't bubble out thanks to
  // stopPropagation on the toggle; only clicks that miss the panel reach document).
  document.addEventListener('click', () => {
    if (panel.style.display !== 'none') panel.style.display = 'none';
  });
  // Prevent panel clicks from reaching the document handler above.
  panel.addEventListener('click', (e) => e.stopPropagation());

  // Load saved name
  nameInput.value = localStorage.getItem('coopName') || '';

  // Uppercase whatever the user types (friend's code field).
  codeInput.addEventListener('input', () => {
    const pos = codeInput.selectionStart;
    codeInput.value = codeInput.value.toUpperCase();
    codeInput.setSelectionRange(pos, pos);
  });

  // Generate this device's own code on load, show it in the top-left chip, and
  // immediately auto-join that room so a friend typing our code finds us there.
  // Falls back to a locally-generated code if the server is unreachable — never blank.
  _generateUniqueCode().then(async (code) => {
    ownCode = code;
    _updateChip(code);
    const savedName = localStorage.getItem('coopName') || nameInput.value || 'Player';
    try {
      await joinSession(code, { name: savedName, mode: currentMode });
      joined = true;
      if (isLightningEnabled()) activateWithCode(code);
    } catch (e) {
      console.warn('[coop] auto-join own room failed', e);
    }
  });

  joinBtn.addEventListener('click', handleJoin);
  leaveBtn.addEventListener('click', handleLeave);
  muteBtn.addEventListener('click', handleMute);

  // Peer events
  onPeerJoin((identity, displayName) => {
    setStatus(`${displayName} joined`, 'ok');
    refreshCount();
  });
  onPeerLeave((identity) => {
    setStatus('A player left', 'warn');
    refreshCount();
  });
}

// Alphanumeric alphabet — uppercase only, visually unambiguous (no 0/O/1/I/L).
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function _randomCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

// Pick a 4-char alphanumeric code that isn't already an active server session.
// Falls back to the candidate immediately if the server is unreachable.
async function _generateUniqueCode() {
  const backend = getBackendUrl();
  for (let i = 0; i < 10; i++) {
    const candidate = _randomCode();
    try {
      const r = await fetch(`${backend}/session/${candidate}`);
      const d = await r.json();
      if (!d.exists) return candidate;
    } catch {
      return candidate; // server unreachable — use candidate
    }
  }
  return _randomCode();
}

// Show the SESSION chip whenever there's a valid code — pre-join (hosting) or joined.
// Hides the chip only when the field is empty or invalid.
function _updateChip(code) {
  if (code && /^[A-Z0-9]{1,8}$/.test(code)) {
    sessionChip.textContent = `SESSION ${code}`;
    sessionChip.style.display = 'block';
  } else {
    sessionChip.style.display = 'none';
  }
}

async function handleJoin() {
  const code = codeInput.value.trim().toUpperCase();
  const name = nameInput.value.trim() || 'Player';

  if (!code || !/^[A-Z0-9]{1,8}$/.test(code)) {
    setStatus('Enter your friend\'s code', 'err');
    return;
  }

  localStorage.setItem('coopName', name);
  joinBtn.disabled = true;
  setStatus('Connecting…', '');

  try {
    await joinSession(code, { name, mode: currentMode });
    joined = true;
    showJoined(code);
    setStatus('Connected!', 'ok');
    refreshCount();
    // Unify Lightning session with the coop room code so one payment upgrades all.
    if (isLightningEnabled()) activateWithCode(code);
  } catch (err) {
    console.error('[coop]', err);
    setStatus(err.message, 'err');
    joinBtn.disabled = false;
  }
}

async function handleLeave() {
  await leaveSession();
  joined = false;
  showDisconnected();
  setStatus('Left session', '');
  if (isLightningEnabled()) deactivateLightning();
}

async function handleMute() {
  muted = !muted;
  await setMicEnabled(!muted);
  muteBtn.textContent = muted ? '🔇 UNMUTE' : '🎙 MUTE';
}

function showJoined(code) {
  panel.querySelector('#coop-join').style.display  = 'none';
  panel.querySelector('#coop-leave').style.display = 'inline-block';
  muteBtn.style.display = 'inline-block';
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
  muted = false;
  muteBtn.textContent = '🎙 MUTE';
  // Restore chip to own code (device is no longer in any friend's room).
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
    /* Mobile only: place CO-OP in the gap between RECENTER and SCREEN/VR/AR row.
       RECENTER has an inline bottom:90px so we need !important to push it up,
       creating a 35px gap (105px − 70px mode-top) for the 29px CO-OP button. */
    @media (max-width: 480px) {
      #recenter-btn { bottom: 110px !important; }
      #coop-toggle  { bottom: 73px; }
      #coop-panel   { bottom: 112px; }
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
      padding-right: 20px; /* clear the close button */
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
    .coop-code-row { display: flex; gap: 6px; }
    .coop-code-row input { flex: 1; }
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
    #coop-gen {
      background: rgba(0,0,0,0.5);
      border: 1px solid #7df6;
      border-radius: 5px;
      color: #7df;
      font: 700 14px monospace;
      cursor: pointer;
      padding: 0 10px;
      flex-shrink: 0;
    }
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
  `;
  document.head.appendChild(s);
}
