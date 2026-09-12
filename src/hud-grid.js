import { registerClusterMember, layout as relayoutPanels } from './panel-layout.js';

/**
 * hud-grid.js — the flat/mobile HUD control cluster: one 2x3 grid of identical
 * buttons in the bottom-left corner, plus the two things that hang off it (the
 * unavailable-mode tooltip and the RECENTER popup).
 *
 *     [ CO-OP ][ WORLD ][ GYRO ]
 *     [ SCREEN][  VR   ][  AR  ]
 *
 * ── IT ADOPTS, IT DOES NOT BUILD ────────────────────────────────────────────
 * Five of the six buttons already exist and already know what they do: CO-OP
 * belongs to coop-hud.js, WORLD to skin-hud.js, and the mode row to
 * modeswitcher.js. Rebuilding them here would mean two modules owning one
 * button's behaviour, which is the failure this codebase keeps writing rules
 * against. So each module still creates and wires its own button; `adopt()`
 * takes the element it made, drops it into a grid cell and gives it the shared
 * look. Only GYRO is built here, because only here is there anything to hang it
 * on — and even then the behaviour comes from movement.js's controller.
 *
 * The cost of adopting is that the adopted buttons' own fixed-position CSS has
 * to go, or a `width:` from a media query would beat the grid track. Those rules
 * are DELETED from their modules rather than overridden from here: an
 * `!important` war between two stylesheets over one button is the same
 * double-writer problem wearing a different hat.
 *
 * ── EQUAL BY CONSTRUCTION, NOT BY MEASUREMENT ───────────────────────────────
 * `grid-template-columns: repeat(3, 1fr)` with a fixed row height is what makes
 * the six boxes identical; nothing measures a button and copies its size onto
 * the others. The only measured value is the grid's WIDTH, because the one thing
 * it must never do is touch the SHOOT button:
 *
 *     gridW = min(100vw - 32px, SHOOT.left - 16px - 12px, 340px)
 *
 * SHOOT.left is measured from its real bounding box (it moves between portrait,
 * narrow-phone and landscape rules), published as a custom property, and the
 * min() itself stays in CSS so the expression reads the way the mode switcher's
 * old column math did.
 *
 * ── DESKTOP ─────────────────────────────────────────────────────────────────
 * Same grid, same rules, GYRO hidden — a desktop has no gyroscope to toggle.
 * Every cell is explicitly placed (`grid-area`), so hiding GYRO leaves the third
 * track of the top row empty instead of pulling SCREEN up into it.
 */

// ── The one style token set (documented in HUD-STYLE.md) ─────────────────────
const BTN_H     = 44;   // px — the minimum comfortable touch target
const GAP       = 6;    // px — between columns, and between the two rows
const EDGE      = 16;   // px — from the left and bottom viewport edges
const SHOOT_PAD = 12;   // px — minimum clear air between the grid and SHOOT
const MAX_W     = 340;  // px — the grid never grows past this on a wide screen
const POPUP_H   = 36;   // px — the RECENTER popup

// ── Icons ────────────────────────────────────────────────────────────────────
// Inline SVG, `currentColor`, no emoji. The viewBox is 18x18 so one unit is one
// CSS pixel at 1x: a 1.75 stroke is literally 1.75px and the geometry can be put
// on half-pixel centres, which is what keeps them crisp instead of smeared.
const ICON = (paths) =>
  `<svg class="hud-ico" width="18" height="18" viewBox="0 0 18 18" fill="none"
        stroke="currentColor" stroke-width="1.75" stroke-linecap="round"
        stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

// Two figures: a head and the shoulders under it, the second set behind and to
// the right so they read as two people rather than one wide one.
const ICON_COOP = ICON(`
  <circle cx="6.5" cy="5.5" r="2.6" />
  <path d="M1.9 14.6c0-2.5 2.1-4.2 4.6-4.2s4.6 1.7 4.6 4.2" />
  <path d="M12.2 4.2a2.6 2.6 0 0 1 0 5" opacity="0.85" />
  <path d="M13 10.7c1.9.4 3.1 1.9 3.1 3.9" opacity="0.85" />`);

// A globe: the sphere, one meridian seen edge-on as a narrow ellipse, and the
// equator. Not a palette — a world is a place, not a colour scheme.
const ICON_WORLD = ICON(`
  <circle cx="9" cy="9" r="7.1" />
  <ellipse cx="9" cy="9" rx="3" ry="7.1" />
  <path d="M2.2 6.7h13.6M2.2 11.3h13.6" />`);

// Free-look: an eye with two arrows curving around it.
const ICON_GYRO = ICON(`
  <path d="M3.6 9s2.2-3.1 5.4-3.1S14.4 9 14.4 9s-2.2 3.1-5.4 3.1S3.6 9 3.6 9Z" />
  <circle cx="9" cy="9" r="1.5" />
  <path d="M14.9 4.6a7.4 7.4 0 0 1 1.5 2.6M3.1 13.4a7.4 7.4 0 0 1-1.5-2.6" />
  <path d="M16.6 4.4l-1.9.5.5 1.9M1.4 13.6l1.9-.5-.5-1.9" />`);

// ── Module state ─────────────────────────────────────────────────────────────
let grid = null;
let gyroBtn = null;
let popup = null;
let tooltip = null;
let tooltipTimer = null;
let gyroApi = null;
let shootEl = null;

/** Cell name → grid-area. Explicit, so a hidden GYRO leaves its track empty. */
const CELLS = {
  coop:   '1 / 1', world:  '1 / 2', gyro: '1 / 3',
  screen: '2 / 1', vr:     '2 / 2', ar:   '2 / 3',
};

/**
 * Build the (empty) grid. Call before the modules that own the buttons, then
 * `adopt()` each one as it is created.
 * @param {object} opts
 * @param {object|null} opts.gyro movement.js's gyro controller, or null on desktop
 */
export function setupHudGrid({ gyro } = {}) {
  injectStyles();
  gyroApi = gyro || null;

  grid = document.createElement('div');
  grid.id = 'hud-grid';
  document.body.appendChild(grid);

  buildGyroButton();
  buildTooltip();
  measure();

  // The grid width follows SHOOT, which moves with the viewport's own media
  // queries — so re-measure on anything that can move it.
  window.addEventListener('resize', measure);
  window.addEventListener('orientationchange', () => setTimeout(measure, 60));
  window.visualViewport?.addEventListener('resize', measure);

  // ...and a WATCHDOG, for the same reason scene.js has one. A single measure at
  // setup is a measure taken at whatever moment setup happened to run: caught
  // headless, the grid read SHOOT before its box existed, fell back to the
  // viewport edge and stayed 340px wide — straight through the button it is
  // supposed to keep 12px clear of. A ResizeObserver on SHOOT catches every
  // later change, and the settle burst covers the first second, where mobile
  // browser chrome and font loading are still moving things.
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => measure());
    const watch = () => { const el = document.getElementById('shoot-btn'); if (el) ro.observe(el); };
    watch();
    ro.observe(grid);
  }
  for (const t of [0, 60, 250, 600, 1200]) setTimeout(measure, t);
  requestAnimationFrame(measure);

  // A tap anywhere else closes the tooltip. Capture phase, so a button's own
  // stopPropagation cannot leave a stale tooltip on screen.
  document.addEventListener('click', (e) => {
    if (tooltip && !tooltip.contains(e.target)) hideTooltip();
  }, true);

  return { adopt, showTooltip, refresh: measure };
}

const ICONS = { coop: ICON_COOP, world: ICON_WORLD, gyro: ICON_GYRO };

/**
 * Move an existing button into a cell and give it the shared treatment.
 * @param {string} cell one of CELLS
 * @param {HTMLElement} el the button its own module built
 * @param {object} [opts]
 * @param {string} [opts.icon] an ICONS key — action buttons only; modes have none
 * @param {string} [opts.label] uppercase label; defaults to the element's text
 */
export function adopt(cell, el, { icon, label } = {}) {
  if (!grid || !el) return null;
  const svg = ICONS[icon] || '';
  const text = (label ?? el.textContent ?? '').trim().toUpperCase();
  el.classList.add('hud-btn', svg ? 'hud-btn-action' : 'hud-btn-mode');
  el.style.gridArea = CELLS[cell];
  el.innerHTML = `${svg}<span class="hud-label">${text}</span>`;
  grid.appendChild(el);
  fitLabel(el);
  return el;
}

// ── GYRO: the only button built here ─────────────────────────────────────────
function buildGyroButton() {
  gyroBtn = document.createElement('button');
  gyroBtn.id = 'gyro-toggle';
  gyroBtn.type = 'button';
  adopt('gyro', gyroBtn, { icon: 'gyro', label: 'GYRO' });

  // No gyroscope, no toggle. The cell stays empty rather than showing a control
  // that could only ever refuse.
  if (!gyroApi?.isAvailable()) {
    gyroBtn.style.display = 'none';
    return;
  }

  popup = document.createElement('div');
  popup.id = 'recenter-pop';
  popup.style.display = 'none';
  popup.innerHTML = `<button id="recenter-go" type="button">RECENTER</button>`;
  document.body.appendChild(popup);
  registerClusterMember(popup);
  popup.querySelector('#recenter-go').addEventListener('click', (e) => {
    e.stopPropagation();
    gyroApi.recenter();
    e.currentTarget.blur();
  });

  // The popup is CLUSTER FURNITURE, not a panel: it is attached to GYRO, one
  // button wide, and it never competes for the panel home. Registering it as a
  // panel was tried and was wrong — P43 resolves two open panels, and a third
  // fell out of that rule and shoved the CO-OP panel off the right edge of a
  // 390px screen. Declaring it part of the cluster makes the CO-OP and WORLD
  // panels come home above it, which is all it ever needed.

  // The permission request must happen inside the gesture, so it is awaited
  // here in the click handler rather than deferred to a later tick.
  gyroBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    gyroBtn.blur();
    if (gyroApi.isOn()) { gyroApi.disable(); renderGyro(); return; }
    const ok = await gyroApi.enable();
    renderGyro();
    if (!ok) showTooltip(gyroBtn, 'Motion access was not granted');
  });

  // Restore the session's choice. On iOS an ungranted origin will simply refuse
  // outside a gesture, and the button honestly comes back OFF.
  if (sessionStorage.getItem('hudGyro') === 'on') {
    gyroApi.enable().then(renderGyro).catch(() => {});
  }
  renderGyro();
}

function renderGyro() {
  if (!gyroBtn || !gyroApi) return;
  const on = gyroApi.isOn();
  gyroBtn.classList.toggle('active', on);
  gyroBtn.setAttribute('aria-pressed', String(on));
  if (popup) {
    popup.style.display = on ? 'block' : 'none';
    relayoutPanels();   // the cluster just got taller or shorter
  }
  try { sessionStorage.setItem('hudGyro', on ? 'on' : 'off'); } catch { /* private mode */ }
}

// ── Tooltip ──────────────────────────────────────────────────────────────────
function buildTooltip() {
  tooltip = document.createElement('div');
  tooltip.id = 'hud-tooltip';
  tooltip.setAttribute('role', 'status');
  tooltip.style.display = 'none';
  document.body.appendChild(tooltip);
}

/**
 * One tooltip, above `anchor`, gone in two seconds or on the next tap outside.
 * Showing a second one replaces the first rather than stacking.
 *
 * "Above the button" has to mean above the CLUSTER, not above that button's own
 * box: the mode row is the lower of two rows, so a tooltip 8px over the VR
 * button lands squarely on WORLD and GYRO. It is centred on the button it
 * explains (that is what makes it point at anything) and lifted clear of the
 * whole grid, then clamped to the viewport so a wide string near an edge does
 * not run off it.
 */
export function showTooltip(anchor, text) {
  if (!tooltip || !anchor) return;
  clearTimeout(tooltipTimer);
  tooltip.textContent = text;
  tooltip.style.display = 'block';
  tooltip.style.left = '0px';          // measure unclamped first

  const a = anchor.getBoundingClientRect();
  const cluster = grid ? grid.getBoundingClientRect() : a;
  const t = tooltip.getBoundingClientRect();
  const left = Math.max(8, Math.min(
    a.left + a.width / 2 - t.width / 2,
    window.innerWidth - t.width - 8,
  ));
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.bottom = `${Math.round(window.innerHeight - cluster.top + 8)}px`;
  tooltipTimer = setTimeout(hideTooltip, 2000);
}

function hideTooltip() {
  clearTimeout(tooltipTimer);
  if (tooltip) tooltip.style.display = 'none';
}

// ── Measurement: the grid's width, and where the GYRO column starts ──────────
function measure() {
  if (!grid) return;
  // Re-looked-up every time: SHOOT may not exist yet on the first pass, and a
  // cached null would make the fallback permanent.
  shootEl = document.getElementById('shoot-btn') || shootEl;
  const r = shootEl?.getBoundingClientRect();
  // No SHOOT button (it can be absent before the HUD builds): fall back to the
  // right edge, which the 100vw and 340px terms still bound.
  const shootLeft = r && r.width ? r.left : window.innerWidth;
  document.documentElement.style.setProperty('--hud-shoot-left', `${Math.round(shootLeft)}px`);

  // The popup is one column wide and sits over the GYRO column. Both come from
  // the grid's own measured box, so they cannot drift from it.
  const g = grid.getBoundingClientRect();
  const col = (g.width - 2 * GAP) / 3;
  document.documentElement.style.setProperty('--hud-col-w', `${col}px`);
  document.documentElement.style.setProperty('--hud-gyro-left', `${Math.round(g.left + 2 * (col + GAP))}px`);

  for (const el of grid.children) fitLabel(el);
}

/**
 * Labels never wrap. If one would overflow its track, tracking is given up
 * first — the spec's order, and the right one: 0.08em of letter-spacing is
 * decoration, whereas a smaller font is a different type scale on one button.
 */
function fitLabel(btn) {
  const label = btn.querySelector?.('.hud-label');
  if (!label) return;
  label.style.letterSpacing = '';
  const room = btn.clientWidth - (btn.querySelector('.hud-ico') ? 26 : 8);
  if (room <= 0) return;
  for (const ls of ['0.08em', '0.05em', '0.02em', '0em']) {
    label.style.letterSpacing = ls;
    if (label.scrollWidth <= room) return;
  }
}

// ── Styles ───────────────────────────────────────────────────────────────────
function injectStyles() {
  const style = document.createElement('style');
  style.id = 'hud-grid-style';
  style.textContent = `
    /* ── The HUD style tokens. One place; see HUD-STYLE.md. ────────────────── */
    :root {
      --hud-radius:   0;                       /* sharp everywhere, by brand */
      --hud-border-w: 1.5px;
      --hud-border:   var(--ui-primary);
      --hud-bg:       var(--ui-panel);         /* theme panelBg */
      --hud-fill:     var(--ui-primary-18);    /* active fill */
      --hud-glow:     0 0 8px var(--ui-primary-50);
      --hud-text:     var(--ui-text);
      --hud-font:     700 12px/1 monospace;
      --hud-track:    0.08em;
      --hud-btn-h:    ${BTN_H}px;
      --hud-gap:      ${GAP}px;
      --hud-edge:     ${EDGE}px;
      --hud-shoot-left: 100vw;                 /* measured; see measure() */
    }
    @media (min-width: 769px) { :root { --hud-font: 700 13px/1 monospace; } }

    /* ── The grid ──────────────────────────────────────────────────────────── */
    #hud-grid {
      position: fixed;
      left: var(--hud-edge);
      bottom: var(--hud-edge);
      z-index: 9100;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      grid-template-rows: repeat(2, var(--hud-btn-h));
      gap: var(--hud-gap);
      /* The one measured rule: never within 12px of SHOOT's box. */
      width: min(
        calc(100vw - 2 * var(--hud-edge)),
        calc(var(--hud-shoot-left) - var(--hud-edge) - ${SHOOT_PAD}px),
        ${MAX_W}px
      );
      font-family: monospace;
    }

    /* ── One footprint, two treatments ─────────────────────────────────────── */
    .hud-btn {
      /* Adopted buttons arrive with their own fixed position; the grid owns it
         now. Everything else about them — their click handler — is untouched. */
      position: static;
      box-sizing: border-box;
      width: 100%;
      height: var(--hud-btn-h);
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 0 4px;
      border: var(--hud-border-w) solid var(--hud-border);
      border-radius: var(--hud-radius);
      /* The SURFACE is the theme's panelBg (the shared token); what "outlined"
         means here is that an inactive button carries no PRIMARY tint, only the
         border. A literally transparent fill was tried and rejected: over
         Classic's lit cyan floor the 12px label simply disappeared, and a
         contrast figure against "whatever the arena is showing" is not a figure
         at all. See HUD-STYLE.md. */
      background: var(--hud-bg);
      color: var(--hud-text);
      font: var(--hud-font);
      cursor: pointer;
      overflow: hidden;
      transition: background .15s, box-shadow .15s, opacity .15s;
    }
    .hud-label {
      letter-spacing: var(--hud-track);
      text-transform: uppercase;
      white-space: nowrap;
    }
    .hud-ico { flex: 0 0 18px; }

    .hud-btn:hover:not(.disabled) {
      background: linear-gradient(var(--ui-primary-faint), var(--ui-primary-faint)), var(--hud-bg);
      box-shadow: var(--hud-glow);
    }
    .hud-btn:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 2px; }

    /* Active: the mode you are in, and GYRO while it is on. */
    /* Active: primary at 18% over the same surface, a full-primary border and the
       glow. The LABEL stays the theme's text colour on purpose. Painting it
       primary as well was tried and measured 2.93:1 in Carnivorous — blood-red
       text on a blood-red wash — and the spec never asked for it: the active
       state is the fill, the border and the glow. Keeping the label constant
       also means one label colour across all six buttons, which is what makes
       the row read as a set. */
    .hud-btn.active {
      background: linear-gradient(var(--hud-fill), var(--hud-fill)), var(--hud-bg);
      border-color: var(--ui-primary);
      box-shadow: var(--hud-glow);
    }
    .hud-btn.active .hud-ico { color: var(--ui-primary); }

    /* Unavailable: dimmed, still tappable — the tap is what explains it. */
    .hud-btn.disabled {
      opacity: 0.40;
      cursor: pointer;
      box-shadow: none;
    }
    .hud-btn.checking { opacity: 0.55; cursor: default; }

    /* ── RECENTER popup: one column wide, directly over GYRO ───────────────── */
    #recenter-pop {
      position: fixed;
      left: var(--hud-gyro-left, 16px);
      bottom: calc(var(--hud-edge) + 2 * var(--hud-btn-h) + 2 * var(--hud-gap));
      width: var(--hud-col-w, 88px);
      height: ${POPUP_H}px;
      z-index: 9050;
    }
    #recenter-go {
      width: 100%; height: 100%;
      box-sizing: border-box;
      display: flex; align-items: center; justify-content: center;
      border: var(--hud-border-w) solid var(--ui-primary);
      border-radius: var(--hud-radius);
      background: var(--hud-bg);
      color: var(--ui-primary);
      font: 700 11px/1 monospace;
      letter-spacing: var(--hud-track);
      cursor: pointer;
      box-shadow: var(--hud-glow);
    }
    #recenter-go:hover { background: var(--hud-fill); }

    /* ── Tooltip ───────────────────────────────────────────────────────────── */
    #hud-tooltip {
      position: fixed;
      z-index: 9600;
      max-width: min(260px, calc(100vw - 24px));
      padding: 8px 10px;
      border: var(--hud-border-w) solid var(--ui-primary);
      border-radius: var(--hud-radius);
      background: var(--hud-bg);
      color: var(--hud-text);
      font: 11px/1.35 monospace;
      letter-spacing: 0.04em;
      text-align: center;
      pointer-events: none;
      box-shadow: var(--hud-glow);
    }

    /* ── Sharp everywhere (the brand rule) ─────────────────────────────────── */
    /* The elements named in the P55 spec, plus the controls inside them. The
       round SHOOT reticle, the loading spinners and the co-op status dot are not
       in that list and stay round: they are circular because of what they are,
       not because of a rounding style. */
    #hud-grid, #hud-grid > *, #hud-tooltip, #recenter-pop, #recenter-go,
    #score, #session-chip, #upgrade-btn, #rf-panel,
    #coop-panel, #coop-panel input, #coop-panel button, #coop-panel .coop-req,
    #world-panel, #world-panel input, #world-panel button, #world-panel .skin-row,
    #skin-toast, #coop-toast, #cmp-wait, #cmp-left, #cmp-proposal, #cmp-end,
    #pay-modal, #pay-modal button, #pay-modal a {
      border-radius: 0 !important;
    }
  `;
  document.head.appendChild(style);
}
