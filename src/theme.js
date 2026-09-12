/**
 * theme.js — skin-driven UI colour, v1: COLOURS ONLY.
 *
 * A skin declares a `ui` palette; everything the player sees reads that palette
 * instead of a literal. No layout, no sizes, no shapes — this pass changes what
 * colour a thing is and nothing else.
 *
 * ── The pattern (this is the reusable bit) ──────────────────────────────────
 * ONE source (the active skin's tokens) and ONE consumer path with two bridges,
 * because the UI lives in two different rendering worlds:
 *
 *     skin.ui  ──►  applyTheme()  ──┬──►  CSS custom properties on :root
 *                                   │      (DOM HUD, panels, buttons, toasts —
 *                                   │       they read var(--ui-*) and NOTHING
 *                                   │       else, so they restyle for free)
 *                                   │
 *                                   └──►  a JS theme object + change callbacks
 *                                          (the WebGL side — canvas textures and
 *                                           in-world text cannot read CSS, so
 *                                           they subscribe and repaint)
 *
 * The DOM half needs no repaint at all: rewriting a custom property on :root
 * restyles every rule that references it. The WebGL half must be told, because
 * its "styles" are pixels already baked into a canvas texture.
 *
 * ── Why there is a DERIVED layer ────────────────────────────────────────────
 * Real UI needs a colour at several strengths — a solid border, a faint hover
 * wash, a dim rule. Declaring every one of those per skin would be a palette of
 * thirty entries that skin authors get subtly wrong. Instead a skin declares 8
 * tokens and this module derives the alpha variants from them, so the whole set
 * stays in proportion no matter what a skin picks. Derivation happens in JS
 * rather than with CSS color-mix() so the output is a plain rgba() string that
 * works everywhere, including older mobile Safari.
 *
 * ── DANGER IS NOT NEGOTIABLE ────────────────────────────────────────────────
 * A skin may TINT danger; it may not lose it. assertDanger() below pushes any
 * declared danger colour back toward red if a skin strays, so LEAVE and EXIT
 * read as destructive in every skin. Getting this wrong is not a cosmetic bug —
 * it is a player leaving a session they meant to stay in.
 *
 * ── FUTURE SKILL ────────────────────────────────────────────────────────────
 * "Skin-driven UI theming: declare tokens on the theme owner, bridge them to CSS
 * custom properties for DOM and to a subscribe/repaint object for canvas/WebGL;
 * derive alpha variants centrally; keep danger semantic." Worth folding into the
 * webxr-threejs skill once a second project needs it.
 */

// ── The schema ───────────────────────────────────────────────────────────────
/**
 * @typedef {object} UiPalette
 * @property {string} primary    structure and affirmative action — borders, active state
 * @property {string} accent     the secondary hue; highlights, the second player
 * @property {string} danger     destructive: LEAVE, EXIT, disabled-for-fairness
 * @property {string} ok         connected / succeeded / your own score
 * @property {string} text       body text on panelBg
 * @property {string} textMuted  hints, labels, disabled text
 * @property {string} panelBg    panel and scrim base (opaque; alpha is derived)
 * @property {string} glow       the emissive signature colour — score, rapid fire
 */

// `ok` is the one addition to the requested seven. The codebase already uses a
// distinct success green (connection state, the peer's score, the co-op menu's
// "joined" line) and folding it into `accent` would have made "connected" and
// "highlighted" the same colour — a real loss of meaning, not a saving.
export const DEFAULT_UI = Object.freeze({
  primary:   '#00e5ff',
  accent:    '#b14bff',
  danger:    '#ff5d6c',
  ok:        '#4dff9e',
  text:      '#cfe6ff',
  textMuted: '#8fa8bd',
  panelBg:   '#06060e',
  glow:      '#f7931a',
});

// ── Colour helpers ───────────────────────────────────────────────────────────

/** '#abc' | '#aabbcc' | '#aabbccdd' -> {r,g,b} 0-255. Null on anything else. */
function parseHex(hex) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((c) => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6);
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

/** rgba() string at a given alpha. */
function alpha(hex, a) {
  const c = parseHex(hex) || { r: 255, g: 255, b: 255 };
  return `rgba(${c.r},${c.g},${c.b},${a})`;
}

/** Mix toward white (t>0) or black (t<0). Used for hover/pressed states. */
function shade(hex, t) {
  const c = parseHex(hex) || { r: 255, g: 255, b: 255 };
  const target = t >= 0 ? 255 : 0;
  const k = Math.abs(t);
  return `#${[c.r, c.g, c.b]
    .map((v) => clamp255(v + (target - v) * k).toString(16).padStart(2, '0'))
    .join('')}`;
}

/** Relative luminance, 0..1. */
function luminance(hex) {
  const c = parseHex(hex);
  if (!c) return 1;
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

/** WCAG contrast ratio between two colours. */
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * A skin may TINT danger; it may not lose it. If a declared danger colour is not
 * recognisably red — too little red relative to green/blue, or so dark it reads
 * as a shadow — it is pulled back toward the default. A skin gets its tint; the
 * player keeps the signal.
 */
function assertDanger(hex) {
  const c = parseHex(hex);
  if (!c) return DEFAULT_UI.danger;
  const dominant = c.r >= c.g * 1.25 && c.r >= c.b * 1.25;
  const bright   = c.r >= 120;
  if (dominant && bright) return hex;
  const d = parseHex(DEFAULT_UI.danger);
  console.warn(`[theme] danger "${hex}" does not read as danger — pulled toward ${DEFAULT_UI.danger}`);
  return `#${[Math.max(c.r, d.r), Math.min(c.g, d.g), Math.min(c.b, d.b)]
    .map((v) => clamp255(v).toString(16).padStart(2, '0')).join('')}`;
}

// ── State ────────────────────────────────────────────────────────────────────
let _tokens = { ...DEFAULT_UI };
let _theme  = null;      // the resolved object handed to WebGL consumers
const _subs = [];

/** Numeric 0xRRGGBB, which is what three.js Color/material constructors want. */
function toInt(hex) {
  const c = parseHex(hex) || { r: 255, g: 255, b: 255 };
  return (c.r << 16) | (c.g << 8) | c.b;
}

function buildTheme(t) {
  return Object.freeze({
    ...t,
    /** Same palette as 0xRRGGBB ints, for three.js. */
    int: Object.freeze(Object.fromEntries(Object.keys(t).map((k) => [k, toInt(t[k])]))),
    /** rgba() at an arbitrary alpha, for canvas fills. */
    alpha,
    shade,
  });
}

/**
 * Text colour to sit ON a filled swatch: black or white, whichever actually has
 * contrast against it. Hardcoding #fff or #000 on a themed background is the
 * classic way theming breaks legibility — white on Gold's #e8b658 is unreadable,
 * black on a dark skin's primary equally so. Picking by luminance means a skin
 * can choose any colour and its button labels stay readable without the skin
 * author having to think about it.
 */
function onColour(hex) {
  return contrast(hex, '#000000') >= contrast(hex, '#ffffff') ? '#000000' : '#ffffff';
}

/**
 * The derived layer. Each entry is a CSS custom property and the expression that
 * produces it, so the whole set moves together when a skin changes one token.
 */
function cssVars(t) {
  return {
    '--ui-on-primary':     onColour(t.primary),
    '--ui-on-accent':      onColour(t.accent),
    '--ui-on-ok':          onColour(t.ok),
    '--ui-on-glow':        onColour(t.glow),
    '--ui-on-danger':      onColour(t.danger),
    '--ui-primary':        t.primary,
    '--ui-primary-line':   alpha(t.primary, 0.40),   // borders
    '--ui-primary-dim':    alpha(t.primary, 0.25),   // rules, inactive tracks
    '--ui-primary-faint':  alpha(t.primary, 0.10),   // hover wash
    '--ui-primary-bright': shade(t.primary, 0.35),   // hover text
    // P55's two exact strengths. The HUD's brand rule names them as numbers —
    // an active button is primary at 18%, a glow is primary at 50% — so they are
    // derived here with the rest rather than written as literals at the point of
    // use, where a skin change could not reach them.
    '--ui-primary-18':     alpha(t.primary, 0.18),   // active button fill
    '--ui-primary-50':     alpha(t.primary, 0.50),   // active/hover glow

    '--ui-accent':         t.accent,
    '--ui-accent-line':    alpha(t.accent, 0.40),
    '--ui-accent-faint':   alpha(t.accent, 0.12),

    '--ui-danger':         t.danger,
    '--ui-danger-line':    alpha(t.danger, 0.45),
    '--ui-danger-faint':   alpha(t.danger, 0.12),

    '--ui-ok':             t.ok,
    '--ui-ok-faint':       alpha(t.ok, 0.14),

    '--ui-text':           t.text,
    '--ui-text-muted':     t.textMuted,

    '--ui-panel':          alpha(t.panelBg, 0.88),   // panels
    '--ui-panel-solid':    alpha(t.panelBg, 0.95),   // panels over busy scenes
    '--ui-panel-chip':     alpha(t.panelBg, 0.75),   // buttons/chips
    '--ui-scrim':          alpha(t.panelBg, 0.82),   // full-screen overlays
    '--ui-field':          alpha(t.text, 0.07),      // input backgrounds

    '--ui-glow':           t.glow,
    '--ui-glow-soft':      alpha(t.glow, 0.35),
    '--ui-glow-mid':       alpha(t.glow, 0.60),
    '--ui-glow-strong':    alpha(t.glow, 0.90),
  };
}

/**
 * Apply a skin's palette. Missing or malformed tokens fall back to Classic, so a
 * skin that declares no `ui` (or a partial one) still renders themed rather than
 * unthemed.
 * @param {Partial<UiPalette>} [ui]
 * @param {string} [skinId] for logging only
 */
export function applyTheme(ui, skinId = '?') {
  const merged = { ...DEFAULT_UI };
  for (const key of Object.keys(DEFAULT_UI)) {
    const v = ui?.[key];
    if (parseHex(v)) merged[key] = v;
    else if (v != null) console.warn(`[theme] skin "${skinId}" token ${key}="${v}" is not a colour — using ${merged[key]}`);
  }
  merged.danger = assertDanger(merged.danger);

  _tokens = merged;
  _theme  = buildTheme(merged);

  // Bridge 1 — DOM. Writing the custom properties restyles every rule that
  // references them; nothing needs to be re-rendered or re-created.
  const root = document.documentElement;
  for (const [k, v] of Object.entries(cssVars(merged))) root.style.setProperty(k, v);
  root.dataset.skin = skinId;

  // Bridge 2 — WebGL. Canvas textures and in-world text have their colours baked
  // into pixels, so they have to be told to repaint.
  for (const cb of _subs) {
    try { cb(_theme); } catch (e) { console.warn('[theme] subscriber failed', e); }
  }
  return _theme;
}

/** The resolved palette. Always defined — Classic until a skin applies one. */
export function getTheme() {
  if (!_theme) _theme = buildTheme(_tokens);
  return _theme;
}

/**
 * Subscribe to theme changes. Fires immediately with the current theme so a
 * consumer has one code path for "paint" and "repaint".
 * @returns {() => void} unsubscribe
 */
export function onThemeChange(cb) {
  _subs.push(cb);
  try { cb(getTheme()); } catch (e) { console.warn('[theme] subscriber failed', e); }
  return () => { const i = _subs.indexOf(cb); if (i >= 0) _subs.splice(i, 1); };
}

// Paint the default immediately so the HUD is themed on the very first frame,
// before any skin has been built.
if (typeof document !== 'undefined') applyTheme(DEFAULT_UI, 'classic');
