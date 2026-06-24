/**
 * mock-dev-panel.js — floating dev panel for mock/bc transports.
 *
 * Visible only when ?net=mock or ?net=bc (never in a LiveKit production build).
 * Shows live impairment sliders and bot lifecycle controls.
 * Import and call setupMockDevPanel() from main.js after the animation loop starts.
 */

import { getActiveTransportType, getActiveTransport } from './room.js';

export function setupMockDevPanel() {
  const type = getActiveTransportType();
  if (type === 'livekit') return; // hidden in live builds

  const transport = getActiveTransport();
  const ctrl = transport?.getDevControls?.();
  if (!ctrl) return;

  injectStyles();
  buildPanel(type, ctrl);
}

// ── Panel DOM ─────────────────────────────────────────────────────────────────

function buildPanel(type, ctrl) {
  const panel = document.createElement('div');
  panel.id = 'mock-panel';
  panel.innerHTML = `
    <div id="mp-header">
      <span>DEV · ${type.toUpperCase()}</span>
      <button id="mp-toggle" title="collapse">▾</button>
    </div>
    <div id="mp-body">
      <div class="mp-section">IMPAIRMENT</div>

      <label>Latency <span id="mp-lat-v">100</span> ms</label>
      <input type="range" id="mp-lat" min="0" max="500" value="100">

      <label>Jitter <span id="mp-jit-v">40</span> ms</label>
      <input type="range" id="mp-jit" min="0" max="120" value="40">

      <label>Loss <span id="mp-loss-v">4</span> %</label>
      <input type="range" id="mp-loss" min="0" max="40" value="4">

      <label>Reorder <span id="mp-reorder-v">5</span> %</label>
      <input type="range" id="mp-reorder" min="0" max="40" value="5">

      ${type === 'mock' ? `
      <div class="mp-section">BOT</div>
      <div class="mp-row">
        <button id="mp-bjoin">Join</button>
        <button id="mp-bleave">Leave</button>
        <button id="mp-bdeath">Silent☠</button>
        <button id="mp-brecon">Reconnect</button>
      </div>
      <div class="mp-row">
        <button id="mp-bmode">Mode: VR</button>
        <button id="mp-bspeak">Speaking: off</button>
      </div>
      ` : ''}

      <div class="mp-section">STATUS</div>
      <div id="mp-status">—</div>
    </div>
  `;
  document.body.appendChild(panel);

  // ── Impairment sliders ────────────────────────────────────────────────────

  function bindSlider(id, valId, setter, scale) {
    const el = document.getElementById(id);
    const vl = document.getElementById(valId);
    el.addEventListener('input', () => {
      const v = parseFloat(el.value) * scale;
      vl.textContent = el.value;
      setter(v);
    });
  }

  bindSlider('mp-lat',    'mp-lat-v',    ctrl.setLatency, 1);
  bindSlider('mp-jit',    'mp-jit-v',    ctrl.setJitter,  1);
  bindSlider('mp-loss',   'mp-loss-v',   ctrl.setLoss,    0.01);
  bindSlider('mp-reorder','mp-reorder-v',ctrl.setReorder, 0.01);

  // ── Bot controls (mock only) ──────────────────────────────────────────────

  if (type === 'mock') {
    document.getElementById('mp-bjoin').addEventListener('click', () => ctrl.botJoin());
    document.getElementById('mp-bleave').addEventListener('click', () => ctrl.botLeave());
    document.getElementById('mp-bdeath').addEventListener('click', () => ctrl.botSilentDeath());
    document.getElementById('mp-brecon').addEventListener('click', () => ctrl.botReconnect());

    const modeBtn = document.getElementById('mp-bmode');
    modeBtn.addEventListener('click', () => {
      const m = ctrl.toggleBotMode();
      modeBtn.textContent = `Mode: ${m.toUpperCase()}`;
    });

    const speakBtn = document.getElementById('mp-bspeak');
    speakBtn.addEventListener('click', () => {
      const on = !ctrl.isSpeaking();
      ctrl.setSpeaking(on);
      speakBtn.textContent = `Speaking: ${on ? 'on' : 'off'}`;
    });
  }

  // ── Collapse toggle ───────────────────────────────────────────────────────

  let collapsed = false;
  const body    = document.getElementById('mp-body');
  document.getElementById('mp-toggle').addEventListener('click', () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : '';
    document.getElementById('mp-toggle').textContent = collapsed ? '▸' : '▾';
  });

  // ── Live status ticker ────────────────────────────────────────────────────

  const statusEl = document.getElementById('mp-status');
  setInterval(() => {
    const imp = ctrl.getImpairment();
    statusEl.textContent =
      `lat:${imp.latency}ms jit:±${imp.jitter}ms ` +
      `loss:${(imp.loss * 100).toFixed(0)}% ` +
      `reorder:${(imp.reorder * 100).toFixed(0)}%`;
  }, 500);
}

// ── Styles ────────────────────────────────────────────────────────────────────

function injectStyles() {
  const s = document.createElement('style');
  s.textContent = `
    #mock-panel {
      position: fixed;
      top: 10px;
      right: 10px;
      z-index: 9999;
      background: rgba(10,10,20,0.88);
      border: 1px solid #335;
      border-radius: 6px;
      color: #adf;
      font: 12px/1.4 monospace;
      min-width: 210px;
      max-width: 240px;
      pointer-events: all;
    }
    #mp-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 5px 8px;
      background: rgba(40,40,80,0.9);
      border-radius: 5px 5px 0 0;
      font-weight: bold;
      color: #8cf;
    }
    #mp-toggle {
      background: none;
      border: none;
      color: #8cf;
      cursor: pointer;
      font-size: 14px;
      padding: 0 2px;
    }
    #mp-body {
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    #mock-panel label {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: #9bd;
    }
    #mock-panel input[type=range] {
      width: 100%;
      height: 4px;
      accent-color: #4af;
      margin-bottom: 4px;
    }
    .mp-section {
      font-size: 10px;
      color: #56a;
      letter-spacing: 1px;
      margin-top: 5px;
      padding-top: 4px;
      border-top: 1px solid #224;
    }
    .mp-row {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }
    #mock-panel button {
      flex: 1;
      min-width: 0;
      padding: 3px 6px;
      font: 11px monospace;
      background: #1a1a3a;
      border: 1px solid #446;
      color: #8cf;
      border-radius: 3px;
      cursor: pointer;
    }
    #mock-panel button:hover {
      background: #2a2a55;
      border-color: #66a;
    }
    #mp-status {
      font-size: 10px;
      color: #678;
      margin-top: 3px;
    }
  `;
  document.head.appendChild(s);
}
