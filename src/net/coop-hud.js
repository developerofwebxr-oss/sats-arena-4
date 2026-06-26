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
  toggle.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  });
  document.body.appendChild(toggle);

  // Panel
  panel = document.createElement('div');
  panel.id = 'coop-panel';
  panel.style.display = 'none';

  panel.innerHTML = `
    <div id="coop-title">CO-OP SESSION</div>
    <div class="coop-row">
      <label class="coop-label">SESSION CODE</label>
      <div class="coop-code-row">
        <input id="coop-code" type="text" inputmode="text" autocapitalize="characters"
               maxlength="8" placeholder="…" autocomplete="off" spellcheck="false" />
        <button id="coop-gen" title="Generate new unique code">⟳</button>
      </div>
      <div class="coop-hint">Share your code, or enter a friend's to join them.</div>
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
  const leaveBtn = panel.querySelector('#coop-leave');
  const genBtn   = panel.querySelector('#coop-gen');

  // Load saved name
  nameInput.value = localStorage.getItem('coopName') || '';

  genBtn.addEventListener('click', async () => {
    genBtn.disabled = true;
    const code = await _generateUniqueCode();
    codeInput.value = code;
    _updateChip(code);
    genBtn.disabled = false;
  });

  // Uppercase whatever the user types so 'ab3k' joins the same room as 'AB3K'.
  // Also update the chip so it mirrors whatever code is in the field.
  codeInput.addEventListener('input', () => {
    const pos = codeInput.selectionStart;
    codeInput.value = codeInput.value.toUpperCase();
    codeInput.setSelectionRange(pos, pos);
    _updateChip(codeInput.value);
  });

  // Pre-fill with a unique code on load (async — doesn't block render).
  // Falls back to a locally-generated code if the server is unreachable (no blank).
  _generateUniqueCode().then((code) => {
    if (!codeInput.value) {
      codeInput.value = code;
      _updateChip(code); // show chip as soon as a code is available, before joining
    }
    codeInput.placeholder = 'AB3K';
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
    setStatus('Enter a session code', 'err');
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
  // Restore chip to whatever code is in the field (pre-join hosting state).
  _updateChip(codeInput.value);
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
    }
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
