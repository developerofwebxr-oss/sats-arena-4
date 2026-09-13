import { listSkins } from './registry.js';
import { isSkinUnlocked, skinPriceSats } from './payment-provider.js';
import { registerPanel } from '../panel-layout.js';

/**
 * skin-hud.js — the DOM control for worlds (flat/mobile).
 *
 *   - a WORLD button in the HUD grid that opens a small picker
 *   - the "Switching world…" overlay both players see during a swap
 *   - gentle toasts for every refusal
 *
 * P55 renamed the player-facing noun from SKIN to WORLD: these are places, not
 * colour schemes, and "skin" undersold what switching one actually does. The
 * code's identifiers still say skin — the registry, the network verbs and the
 * CSS classes are internal, and churning them would touch far more than the
 * words anyone reads.
 *
 * DIMMING RULES (never the words "coming soon"):
 *   locked world           → dimmed + "Unlock to use this world"
 *   during a match         → whole control dimmed + "Not during a match"
 *   peer (not host)        → whole control dimmed + "Only the host can change world"
 * A dimmed row is still tappable so it can explain itself — silence is worse.
 *
 * The immersive VR/AR surface is deliberately NOT built here: the in-world menu
 * lives on the `staging` branch. This module exposes the same actions the menu
 * would call, so wiring it post-merge is a binding, not a rewrite.
 */

let panel, toggleBtn, overlay, toastEl, listEl;
let _net = null, _skins = null;

export function setupSkinHud({ skins, net }) {
  _skins = skins;
  _net   = net;
  injectStyles();

  toggleBtn = document.createElement('button');
  toggleBtn.id = 'world-toggle';
  toggleBtn.type = 'button';
  toggleBtn.textContent = 'WORLD';
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : 'flex';
    if (!open) {
      // Opening the picker is the strongest signal the player may pick a skin,
      // so start every skin's environment download now rather than waiting for
      // idle — skin-net REFUSES a switch to a skin that is not ready yet, so an
      // un-preloaded skin would simply be unpickable. Each preload is
      // idempotent; a load already in flight is reused.
      listSkins().forEach((s) => { try { s.preload?.(); } catch (e) { console.warn('[skins] preload', e); } });
      renderList();
    }
  });
  // Appended so it exists in the document; hud-grid.js then re-parents it into
  // the 2x3 cluster and owns its size and look from there.
  document.body.appendChild(toggleBtn);

  panel = document.createElement('div');
  panel.id = 'world-panel';
  panel.style.display = 'none';
  panel.innerHTML = `
    <button id="skin-close" type="button" aria-label="Close" title="Close">X</button>
    <div id="skin-title">WORLD</div>
    <div id="skin-list"></div>
    <div id="skin-note"></div>
  `;
  document.body.appendChild(panel);
  listEl = panel.querySelector('#skin-list');

  panel.querySelector('#skin-close').addEventListener('click', (e) => {
    e.stopPropagation();
    panel.style.display = 'none';
  });
  panel.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { panel.style.display = 'none'; });

  // Synced pause overlay — shown on BOTH players for the whole swap.
  overlay = document.createElement('div');
  overlay.id = 'skin-overlay';
  overlay.style.display = 'none';
  overlay.innerHTML = `<div class="skin-ov-inner"><div class="skin-ov-spin"></div><div id="skin-ov-text">Switching skin…</div></div>`;
  document.body.appendChild(overlay);

  // P43: shared bottom-left layout. See panel-layout.js — CO-OP's panel used to
  // cover both this panel and the button that opens it.
  registerPanel({ id: 'world', panel, button: toggleBtn });

  toastEl = document.createElement('div');
  toastEl.id = 'skin-toast';
  toastEl.style.display = 'none';
  document.body.appendChild(toastEl);

  renderList();
}

/** Called by skin-net on every pause transition — both players see this. */
export function setSwitchOverlay(on, skinName) {
  if (!overlay) return;
  overlay.style.display = on ? 'flex' : 'none';
  if (on) {
    const t = overlay.querySelector('#skin-ov-text');
    if (t) t.textContent = skinName ? `Switching to ${skinName}…` : 'Switching world…';
    if (panel) panel.style.display = 'none';
  } else {
    renderList();
  }
}

let _toastTimer = null;
export function skinToast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.style.display = 'block';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 2600);
}

function renderList() {
  if (!listEl || !_skins || !_net) return;
  const activeId = _skins.getActiveSkinId();
  const gate     = _net.canSwitch(); // {ok, reason}

  listEl.innerHTML = '';
  for (const skin of listSkins()) {
    const unlocked = isSkinUnlocked(skin.id);
    const price    = skinPriceSats(skin);
    const isActive = skin.id === activeId;
    const loading  = !!skin.isReady && !skin.isReady();   // assets still streaming
    const dimmed   = !unlocked || loading || (!gate.ok && !isActive);

    const row = document.createElement('button');
    row.className = `skin-row${isActive ? ' active' : ''}${dimmed ? ' dim' : ''}`;
    row.innerHTML = `
      <span class="skin-name">${skin.name}</span>
      <span class="skin-meta">${
        isActive ? 'ACTIVE'
        : !unlocked ? 'LOCKED'
        : skin.readyLabel ? skin.readyLabel()
        : (price > 0 ? `${price} sats` : 'FREE')
      }</span>`;

    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isActive) return;
      // Dimmed rows explain themselves rather than doing nothing.
      if (!unlocked)  return skinToast('Unlock to use this world');
      if (loading)    return skinToast('Still loading…');
      if (!gate.ok)   return skinToast(gate.reason);

      const res = _net.requestSwitch(skin.id);
      if (!res.ok) skinToast(res.reason);
      else renderList();
    });
    listEl.appendChild(row);
  }

  const note = panel.querySelector('#skin-note');
  if (note) {
    note.textContent = gate.ok
      ? (_net.hasPeer() ? 'Host picks — both players switch together.' : '')
      : gate.reason;
    note.style.display = note.textContent ? 'block' : 'none';
  }
}

/** Re-render when host/peer/match state may have changed. */
export function refreshSkinHud() { renderList(); }

function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    /* The WORLD button's SIZE AND LOOK are not here: hud-grid.js owns them, as
       it does for every button in the 2x3 cluster. This file used to carry a
       block of fixed-position and media-query column math to keep the button
       clear of CO-OP and RECENTER; the grid makes all of it unnecessary, and
       leaving it in would have fought the grid track for the button's width. */
    #world-panel {
      position: fixed; left: 16px; bottom: 120px; z-index: 8001;
      display: flex; flex-direction: column; gap: 8px;
      width: 210px; padding: 14px;
      background: var(--ui-panel-solid); border: 1.5px solid var(--ui-primary-line);
      color: var(--ui-text); font: 12px monospace;
    }
    /* P56: an X, matching #coop-close exactly — see the note there. */
    #skin-close {
      position: absolute; top: 8px; right: 8px;
      width: 24px; height: 24px;
      display: flex; align-items: center; justify-content: center;
      background: none; border: 1.5px solid var(--ui-primary-line); border-radius: 0;
      color: var(--ui-primary); cursor: pointer; padding: 0;
      font: 700 12px/1 monospace; opacity: .85;
    }
    #skin-close:hover { background: var(--ui-primary-faint); opacity: 1; }
    #skin-close:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 2px; }
    #skin-title { font-weight: 700; letter-spacing: .18em; color: var(--ui-primary); }
    #skin-list { display: flex; flex-direction: column; gap: 6px; }
    .skin-row {
      display: flex; justify-content: space-between; align-items: center; gap: 8px;
      padding: 9px 10px; cursor: pointer;
      border: 1.5px solid var(--ui-primary-line); background: var(--ui-panel-chip);
      color: var(--ui-text); font: 12px monospace; text-align: left;
    }
    .skin-row:hover { background: var(--ui-primary-faint); }
    .skin-row.active {
      border-color: var(--ui-primary); color: var(--ui-primary);
      background: var(--ui-primary-18); box-shadow: 0 0 8px var(--ui-primary-50);
    }
    .skin-row.dim { opacity: .45; }
    .skin-meta { font-size: 10px; opacity: .75; letter-spacing: .08em; }
    #skin-note { font-size: 10px; opacity: .7; line-height: 1.35; }

    /* Synced pause — covers the view on BOTH players for the whole swap. */
    #skin-overlay {
      position: fixed; inset: 0; z-index: 9800;
      display: flex; align-items: center; justify-content: center;
      background: var(--ui-scrim); backdrop-filter: blur(2px);
    }
    .skin-ov-inner { text-align: center; color: var(--ui-primary); font: 700 16px monospace; letter-spacing: .14em; }
    /* A spinner is round because it is a spinner, not because it is rounded —
       the sharp rule is about panels and buttons. */
    .skin-ov-spin {
      width: 34px; height: 34px; margin: 0 auto 14px;
      border: 3px solid var(--ui-primary-dim); border-top-color: var(--ui-primary);
      border-radius: 50%; animation: skin-spin .8s linear infinite;
    }
    @keyframes skin-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .skin-ov-spin { animation-duration: 2.4s; } }

    #skin-toast {
      position: fixed; left: 50%; bottom: 22%; transform: translateX(-50%);
      z-index: 9900; padding: 9px 16px;
      background: var(--ui-panel); border: 1.5px solid var(--ui-primary-line); color: var(--ui-text);
      font: 12px monospace; letter-spacing: .04em; pointer-events: none;
    }
  `;
  document.head.appendChild(style);
}
