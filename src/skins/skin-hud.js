import { listSkins } from './registry.js';
import { isSkinUnlocked, skinPriceSats } from './payment-provider.js';
import { loadArena } from './arena-glb.js';

/**
 * skin-hud.js — the DOM control for skins (flat/mobile).
 *
 *   - a SKIN button bottom-left that opens a small picker
 *   - the "Switching skin…" overlay both players see during a swap
 *   - gentle toasts for every refusal
 *
 * DIMMING RULES (never the words "coming soon"):
 *   locked skin            → dimmed + "Unlock to use this skin"
 *   during a match         → whole control dimmed + "Not during a match"
 *   peer (not host)        → whole control dimmed + "Only the host can change skin"
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
  toggleBtn.id = 'skin-toggle';
  toggleBtn.textContent = '🎨 SKIN';
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : 'flex';
    if (!open) {
      // Opening the picker is the strongest signal the player may pick a skin,
      // so start the environment download now rather than waiting for idle.
      // loadArena() is idempotent — a load already in flight is reused.
      loadArena();
      renderList();
    }
  });
  document.body.appendChild(toggleBtn);

  panel = document.createElement('div');
  panel.id = 'skin-panel';
  panel.style.display = 'none';
  panel.innerHTML = `
    <button id="skin-close" aria-label="Close">✕</button>
    <div id="skin-title">SKIN</div>
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
    if (t) t.textContent = skinName ? `Switching to ${skinName}…` : 'Switching skin…';
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
      if (!unlocked)  return skinToast('Unlock to use this skin');
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
    /* SKIN belongs to the CO-OP control cluster, not to the RECENTER column.
       Desktop: stacked directly ABOVE #coop-toggle (which is left:16 bottom:16,
       31px tall), so 55px clears it by 8px. RECENTER is gyro/mobile-only and
       never appears here. */
    #skin-toggle {
      position: fixed; left: 16px; bottom: 55px; z-index: 8000;
      padding: 8px 12px; border-radius: 8px;
      border: 1px solid #7df6; background: rgba(0,0,0,.55);
      color: #adf; font: 700 12px/1 monospace; letter-spacing: .12em; cursor: pointer;
    }
    #skin-panel {
      position: fixed; left: 16px; bottom: 93px; z-index: 8001;
      display: flex; flex-direction: column; gap: 8px;
      width: 210px; padding: 14px;
      background: rgba(6,6,14,.95); border: 1px solid #7df6; border-radius: 10px;
      color: #cfe6ff; font: 12px monospace;
    }
    #skin-close {
      position: absolute; top: 6px; right: 8px;
      background: none; border: none; color: #7df; cursor: pointer; font-size: 13px;
    }
    #skin-title { font-weight: 700; letter-spacing: .18em; color: #7df; }
    #skin-list { display: flex; flex-direction: column; gap: 6px; }
    .skin-row {
      display: flex; justify-content: space-between; align-items: center; gap: 8px;
      padding: 8px 10px; border-radius: 6px; cursor: pointer;
      border: 1px solid #7df4; background: rgba(0,0,0,.4);
      color: #cfe6ff; font: 12px monospace; text-align: left;
    }
    .skin-row:hover { background: rgba(0,229,255,.10); }
    .skin-row.active { border-color: #00e5ff; color: #00e5ff; }
    .skin-row.dim { opacity: .45; }
    .skin-meta { font-size: 10px; opacity: .75; letter-spacing: .08em; }
    #skin-note { font-size: 10px; opacity: .7; line-height: 1.35; }

    /* Synced pause — covers the view on BOTH players for the whole swap. */
    #skin-overlay {
      position: fixed; inset: 0; z-index: 9800;
      display: flex; align-items: center; justify-content: center;
      background: rgba(4,4,10,.82); backdrop-filter: blur(2px);
    }
    .skin-ov-inner { text-align: center; color: #00e5ff; font: 700 16px monospace; letter-spacing: .14em; }
    .skin-ov-spin {
      width: 34px; height: 34px; margin: 0 auto 14px;
      border: 3px solid rgba(0,229,255,.25); border-top-color: #00e5ff;
      border-radius: 50%; animation: skin-spin .8s linear infinite;
    }
    @keyframes skin-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .skin-ov-spin { animation-duration: 2.4s; } }

    #skin-toast {
      position: fixed; left: 50%; bottom: 22%; transform: translateX(-50%);
      z-index: 9900; padding: 9px 16px; border-radius: 8px;
      background: rgba(0,0,0,.85); border: 1px solid #7df6; color: #cef;
      font: 12px monospace; letter-spacing: .04em; pointer-events: none;
    }

    /* Mobile portrait: SKIN sits BESIDE CO-OP, forming one row above the
       SCREEN/VR/AR switcher — [CO-OP][SKIN] over [SCREEN][VR][AR].

       Placement reuses the mode switcher's OWN column math (modeswitcher.js
       injectStyles + the #coop-toggle rule in coop-hud.js) rather than a
       hand-placed offset, so it tracks any viewport width:
         switcher width  SW  = min(100vw - 28px, 360px)
         column width    COL = (SW - 12px) / 3        (12px = two 6px gaps)
         switcher left   L   = (100vw - SW) / 2
       CO-OP takes column 0 (over SCREEN); SKIN takes column 1 (over VR), i.e.
       left = L + COL + 6px.

       Breakpoint is 480px to MATCH the switcher and CO-OP rules — it was 820px,
       which put SKIN on the mobile offset at tablet widths where the cluster
       math does not apply.

       This also resolves the RECENTER overlap: RECENTER is left:16 width:92
       bottom:110 and ~87px tall (56px circle + two label lines), so the old
       left:16 bottom:150 SKIN button sat directly on its label. SKIN now shares
       CO-OP's row at bottom:73 (30px tall, topping out at 103) and sits in the
       middle column, so it clears RECENTER both vertically and horizontally. */
    @media (max-width: 480px) {
      #skin-toggle {
        bottom: 73px;
        left: calc((100vw - min(calc(100vw - 28px), 360px)) / 2
                   + (min(calc(100vw - 28px), 360px) - 12px) / 3 + 6px);
        width: calc((min(calc(100vw - 28px), 360px) - 12px) / 3);
        box-sizing: border-box;
        text-align: center;
        padding: 8px 4px;
      }
      #skin-panel { bottom: 112px; left: 16px; }
    }
  `;
  document.head.appendChild(style);
}
