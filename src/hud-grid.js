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
let gyroTouched = false;  // the player has used the toggle; the restore stands down
let gyroBlocked = false;  // a tap was refused — the hint panel is showing
let gyroSilent  = false;  // ...and no dialog appeared, so the OS will not ask again

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

  // A tap anywhere else closes whichever transient is up.
  //
  // POINTERDOWN, not click, and this is not a detail: input.js calls
  // preventDefault() on a touchend that lands on the canvas, to stop the
  // synthetic click double-firing a shot. That means a finger tap on the GAME —
  // by far the most likely "somewhere else" — produces no click event at all, so
  // a click-based dismissal silently does nothing on a phone. Measured: the X
  // and the GYRO tap closed the panel, an outside tap did not. pointerdown fires
  // for mouse and touch alike and nothing suppresses it.
  //
  // Capture phase, so a button's own stopPropagation cannot leave a transient
  // stranded on screen — which is how the blocked panel became unclosable.
  const dismissOutside = (e) => {
    if (tooltip && !tooltip.contains(e.target)) hideTooltip();
    if (gyroBlocked && !popup?.contains(e.target) && !gyroBtn?.contains(e.target)) dismissBlocked();
  };
  document.addEventListener('pointerdown', dismissOutside, true);
  document.addEventListener('click', dismissOutside, true);   // belt and braces

  // refresh() is called from main.js once every module has built its button AND
  // its panel — which is the first moment the stand-down observers have anything
  // to observe. Binding them in setupHudGrid() attached them to null: this module
  // is created before coop-hud and skin-hud, by design.
  return {
    adopt,
    showTooltip,
    refresh: () => { standDownForPanels(); measure(); },
  };
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

  // ── One slot above GYRO, two states (P56) ─────────────────────────────────
  // ON            → RECENTER
  // refused       → ALLOW MOTION, plus a hint once a tap has been refused
  //                 WITHOUT a dialog appearing
  // otherwise     → hidden
  //
  // One element rather than two competing for the same 88x36 patch of screen,
  // because two would each need to know whether the other was showing.
  popup = document.createElement('div');
  popup.id = 'gyro-pop';
  popup.style.display = 'none';
  popup.innerHTML = `
    <button id="recenter-go" type="button">RECENTER</button>
    <div id="gyro-block">
      <div id="gyro-hint"></div>
      <div id="gyro-block-row">
        <button id="gyro-allow" type="button">TRY AGAIN</button>
        <button id="gyro-close" type="button" aria-label="Close" title="Close">X</button>
      </div>
    </div>`;
  document.body.appendChild(popup);
  registerClusterMember(popup);

  // The popup is CLUSTER FURNITURE, not a panel: it is attached to GYRO, one
  // button wide, and it never competes for the panel home. Registering it as a
  // panel was tried and was wrong — P43 resolves two open panels, and a third
  // fell out of that rule and shoved the CO-OP panel off the right edge of a
  // 390px screen. Declaring it part of the cluster makes the CO-OP and WORLD
  // panels come home above it, which is all it ever needed.

  popup.querySelector('#recenter-go').addEventListener('click', (e) => {
    e.stopPropagation();
    gyroApi.recenter();
    e.currentTarget.blur();
  });

  // TRY AGAIN re-runs the REAL request every time it is tapped, because the
  // player may have gone to Settings in between. It never reports success it did
  // not get: GYRO only turns on if enable() resolved to a live sensor.
  popup.querySelector('#gyro-allow').addEventListener('click', async (e) => {
    e.stopPropagation();
    e.currentTarget.blur();
    await requestMotion();
  });

  // ── THE WAY OUT (P58) ─────────────────────────────────────────────────────
  // Three of them, because this panel used to have none. `gyroBlocked` was a
  // one-way latch: nothing cleared it but a successful enable, and on an origin
  // where iOS has remembered a denial a successful enable is exactly what can
  // never happen. Five taps measured, five silent refusals, the panel never
  // closed. A state the game can enter and not leave is not a state.
  popup.querySelector('#gyro-close').addEventListener('click', (e) => {
    e.stopPropagation();
    e.currentTarget.blur();
    dismissBlocked();
  });

  gyroBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    gyroBtn.blur();
    gyroTouched = true;
    if (gyroApi.isOn()) {
      gyroApi.disable();
      rememberGyro(false);
      dismissBlocked();          // also clears any stale hint
      return;
    }
    if (gyroBlocked) { dismissBlocked(); return; }   // the missing branch
    await requestMotion();
  });

  // ── Restoring the session's choice, WITHOUT asking (P57) ──────────────────
  // This used to call enable() plainly, which on iOS fired requestPermission()
  // with no user gesture behind it. That is not a harmless failure: Safari
  // spends the page load's one chance on it, so the tap that follows is refused
  // before the dialog is ever shown — and every later tap with it. A player who
  // had ever switched GYRO on therefore found it permanently dead on the next
  // load, which is exactly the reported "it does nothing".
  //
  // `prompt: false` says: resume if the platform needs no permission, otherwise
  // leave it off and wait for a tap, because only a tap may legally ask.
  //
  // The gyroTouched guard stays for the other race: enable() is async, and a
  // player who taps while the restore is in flight must not have their choice
  // overwritten by a promise that started before they pressed anything.
  if (sessionStorage.getItem('hudGyro') === 'on') {
    gyroApi.enable({ prompt: false }).then(() => { if (!gyroTouched) renderGyro(); }).catch(() => {});
  }
  renderGyro();
}

/** Below this, the platform answered without putting a dialog up. */
const SILENT_REFUSAL_MS = 250;

/**
 * Ask for motion, from inside the gesture that called this.
 *
 * iOS remembers a refusal for the origin: every later request resolves 'denied'
 * with no dialog shown at all, which from the player's side is a button that
 * does nothing. The live request is therefore ALWAYS attempted first — a
 * permission restored in Settings must be picked up without a reload, and we
 * must never cache our own pessimism — and HOW LONG IT TOOK is what tells us
 * which refusal we got. A dialog costs human time; a remembered denial comes
 * back in single-digit milliseconds. That distinction is the difference between
 * "you declined, try again" and "your browser will not ask again, here is what
 * to change", and it is measured rather than guessed at.
 */
async function requestMotion() {
  const t0 = performance.now();
  const ok = await gyroApi.enable({ prompt: true });   // reached only from a tap
  const elapsed = performance.now() - t0;

  if (ok) {
    gyroBlocked = false;
    gyroSilent  = false;
    rememberGyro(true);    // only ever remembered when it actually turned on
  } else {
    gyroBlocked = true;
    gyroSilent  = elapsed < SILENT_REFUSAL_MS;
  }
  renderGyro();
  return ok;
}

/** Close the blocked panel and go back to plain finger-drag look. */
function dismissBlocked() {
  gyroBlocked = false;
  gyroSilent  = false;
  renderGyro();
}

/**
 * The GYRO popup stands down when a panel opens (P58b).
 *
 * P43 keeps PANELS off each other, and P55 made the popup cluster furniture so
 * panels come home above it. That is enough in portrait. In LANDSCAPE it is not:
 * the viewport is ~390px tall, the grid already takes 110 of it, and a CO-OP
 * panel that needs 250 has nowhere to go but through whatever is sitting between
 * it and the grid. Restacking horizontally was the alternative and it is worse —
 * it moves a control the player is mid-way through using.
 *
 * So the rule is precedence, not geometry: A PANEL THE PLAYER JUST OPENED OUTRANKS
 * AN ATTACHED POPUP. RECENTER is one tap from coming back (it reappears with the
 * toggle), and the blocked hint is dismissible by design, so neither loses
 * anything by yielding. Nothing here reaches into P43 — it watches the same
 * `display` the panels already mutate, which is the P43 lesson about observing
 * the thing that changes rather than patching four toggles.
 */
let standDownBound = false;
function standDownForPanels() {
  if (standDownBound) return;
  const els = ['coop-panel', 'world-panel'].map((id) => document.getElementById(id));
  if (els.some((el) => !el)) return;     // not built yet; the next refresh will
  standDownBound = true;
  for (const el of els) {
    new MutationObserver(() => {
      const open = el.style.display !== 'none' && el.style.display !== '';
      // Closing is half the rule: what stood down has to stand back up, or
      // "auto-close" is just a slower way of losing RECENTER.
      if (!open) { restorePopupIfClear(); return; }
      if (gyroBlocked) dismissBlocked();
      else if (popup && gyroApi?.isOn()) popup.style.display = 'none';
    }).observe(el, { attributes: true, attributeFilter: ['style'] });
  }
}

/** Put RECENTER back when no panel is covering the corner any more. */
function restorePopupIfClear() {
  if (!popup || !gyroApi?.isOn() || gyroBlocked) return;
  const anyOpen = ['coop-panel', 'world-panel'].some((id) => {
    const el = document.getElementById(id);
    return el && el.style.display !== 'none' && el.style.display !== '';
  });
  if (!anyOpen) popup.style.display = 'block';
}

function renderGyro() {
  if (!gyroBtn || !gyroApi) return;
  const on = gyroApi.isOn();
  gyroBtn.classList.toggle('active', on);
  gyroBtn.classList.toggle('denied', !on && gyroBlocked);
  gyroBtn.setAttribute('aria-pressed', String(on));
  if (popup) {
    const panelOpen = ['coop-panel', 'world-panel'].some((id) => {
      const el = document.getElementById(id);
      return el && el.style.display !== 'none' && el.style.display !== '';
    });
    popup.style.display = ((on || gyroBlocked) && !panelOpen) ? 'block' : 'none';
    popup.classList.toggle('is-blocked', !on && gyroBlocked);
    popup.querySelector('#gyro-hint').textContent = !gyroBlocked ? '' : (gyroSilent
      // No dialog appeared, so there is nothing to tap through — say what to change.
      ? 'Safari is refusing without asking. Settings > Apps > Safari: turn on Motion & Orientation Access, then Clear History and Website Data \u2014 that is what lets it prompt again.'
      // A dialog did appear and was declined; asking again is still worth a tap.
      : 'Motion access declined. Try again, or turn it on in Settings > Apps > Safari.');
    relayoutPanels();   // the cluster just got taller or shorter
  }
  // One transient at a time, the P55 rule: the hint panel and the tooltip never
  // share the screen.
  if (gyroBlocked) hideTooltip();
}

/**
 * Remember the player's INTENT, and only when the player expressed it.
 *
 * renderGyro() used to write this on every render — including the one during
 * boot, before an async restore could have resolved — so a load that could not
 * resume silently erased the choice it was trying to restore. Writing it from
 * the tap handlers alone keeps "I want motion look" true across a reload that
 * was not allowed to ask for permission yet.
 */
function rememberGyro(on) {
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
  document.documentElement.style.setProperty('--hud-grid-w', `${g.width}px`);
  document.documentElement.style.setProperty('--hud-gyro-left', `${Math.round(g.left + 2 * (col + GAP))}px`);

  for (const el of grid.children) fitLabel(el);
  restorePopupIfClear();
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

    /* Refused: the button that is blocked should look blocked, or the red popup
       below it reads as belonging to nothing. Border and icon only — the label
       keeps the theme text colour, as in every other state. */
    .hud-btn.denied { border-color: var(--ui-danger); }
    .hud-btn.denied .hud-ico { color: var(--ui-danger); }

    /* Unavailable: dimmed, still tappable — the tap is what explains it. */
    .hud-btn.disabled {
      opacity: 0.40;
      cursor: pointer;
      box-shadow: none;
    }
    .hud-btn.checking { opacity: 0.55; cursor: default; }

    /* ── The GYRO popup: one column wide, directly over GYRO ──────────────────
       Two states in one slot. RECENTER is fixed at ${POPUP_H}px; the refused
       state is allowed to grow, because a hint that does not fit is a hint
       nobody reads. Both are cluster members, so the CO-OP and WORLD panels come
       home above whichever is showing. */
    #gyro-pop {
      position: fixed;
      left: var(--hud-gyro-left, 16px);
      bottom: calc(var(--hud-edge) + 2 * var(--hud-btn-h) + 2 * var(--hud-gap));
      width: var(--hud-col-w, 88px);
      z-index: 9050;
    }
    #gyro-pop #gyro-block { display: none; }
    #gyro-pop.is-blocked #recenter-go { display: none; }
    #gyro-pop.is-blocked #gyro-block  { display: block; }
    /* The blocked panel carries a sentence, so it takes the GRID'S OWN WIDTH and
       its left edge — the widest thing it can be without reaching past the grid,
       which is itself measured to stay 12px clear of SHOOT. It grows upward, so
       it never covers the grid either. Two lines instead of six at one button's
       width, and it lines up with the cluster rather than floating over it. */
    #gyro-pop.is-blocked {
      width: var(--hud-grid-w, 250px);
      left: var(--hud-edge);
    }
    #gyro-block-row { display: flex; gap: var(--hud-gap); margin-top: var(--hud-gap); }
    #gyro-allow {
      flex: 1 1 auto; height: 30px;
      box-sizing: border-box;
      display: flex; align-items: center; justify-content: center;
      border: var(--hud-border-w) solid var(--ui-primary);
      border-radius: var(--hud-radius);
      background: var(--hud-bg); color: var(--ui-primary);
      font: 700 10px/1 monospace; letter-spacing: var(--hud-track); cursor: pointer;
    }
    #gyro-allow:hover { background: var(--hud-fill); }
    #gyro-close {
      flex: 0 0 30px; height: 30px;
      box-sizing: border-box;
      display: flex; align-items: center; justify-content: center;
      border: var(--hud-border-w) solid var(--ui-primary-line);
      border-radius: var(--hud-radius);
      background: var(--hud-bg); color: var(--ui-primary);
      font: 700 12px/1 monospace; cursor: pointer; padding: 0;
    }
    #gyro-close:hover { background: var(--ui-primary-faint); }
    #gyro-allow:focus-visible, #gyro-close:focus-visible {
      outline: 2px solid var(--ui-primary); outline-offset: 2px;
    }
    #gyro-hint {
      padding: 8px 9px;
      border: var(--hud-border-w) solid var(--ui-danger-line);
      border-radius: var(--hud-radius);
      background: var(--hud-bg);
      color: var(--hud-text);
      font: 10px/1.35 monospace;
      letter-spacing: 0.03em;
    }

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
    #hud-grid, #hud-grid > *, #hud-tooltip, #gyro-pop, #recenter-go, #gyro-allow, #gyro-close, #gyro-hint, #gyro-block,
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
