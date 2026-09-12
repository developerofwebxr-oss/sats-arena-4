/**
 * panel-layout.js — one rule that keeps the bottom-left panels off each other.
 *
 * THE BUG: #coop-panel opens at bottom:54 (desktop) and is ~300 px tall, so it
 * covered #skin-panel, and — worse — it covered #skin-toggle, which is the only
 * way to open the skin picker. The panel you could see made the other one
 * unreachable.
 *
 * The fix is deliberately a RULE, not a set of nudged offsets. Nothing here
 * knows what a co-op panel or a skin panel is; it knows "a panel and the button
 * that opens it", measures both, and places them. Adding a third panel later is
 * one registerPanel() call.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * HOME  Bottom-left, sitting just above the BUTTON CLUSTER — the union of every
 *       registered toggle button. A single open panel is always at home.
 *
 *       Note this is slightly stronger than "above its own button", and it has
 *       to be: on desktop the two toggles are stacked (CO-OP at bottom:16, SKIN
 *       at bottom:55), so a panel anchored only above its OWN button sits right
 *       on top of the other one's. Clearing the whole cluster satisfies "above
 *       its own button" and keeps every button tappable in every state, which is
 *       the actual requirement.
 *
 * BOTH  The panel that was open FIRST keeps home; the newly opened one is
 *       displaced. Opening a second panel must not yank the one you are already
 *       using out from under your cursor.
 *         1. Try a VERTICAL STACK — displaced panel above the home one, with a
 *            gap. Preferred because it works at every width, so the arrangement
 *            does not change character between phone and desktop.
 *         2. If the stack would run off the top, try SIDE BY SIDE — displaced
 *            panel to the right of the home one, both at home's height.
 *         3. If neither fits, see FALLBACK.
 *       The most recently opened panel always gets the higher z-index, whether
 *       or not the geometry can overlap. Explicit z-order is the recurring
 *       HUD-stacking lesson; not relying on DOM order is the point.
 *
 * ONE CLOSES  The survivor is laid out from scratch, so it snaps back home even
 *       if it had been displaced. Layout re-runs on EVERY open and close.
 *
 * FALLBACK (viewport too short AND too narrow for both)
 *       The NEWLY OPENED panel takes home, and the other is closed back to just
 *       its button. Chosen because the alternative — leaving both open and
 *       letting one run off-screen — hides content with no affordance to get it
 *       back, whereas a closed panel still has a visible, tappable button (the
 *       cluster is never covered), so it is one tap to return. The user's most
 *       recent action wins, which is the least surprising resolution.
 *
 * ── How it hooks in ─────────────────────────────────────────────────────────
 * Via a MutationObserver on each panel's style attribute, NOT by patching the
 * panels' toggle handlers. Both modules close their panel from several places —
 * their toggle, their ✕, and a document-click handler — and a fourth path added
 * later would silently bypass a patched toggle. Observing the thing that
 * actually changes catches every path, and it means this file touches neither
 * module's logic.
 *
 * Every position is computed from MEASURED bounding boxes (the P35 lesson), and
 * the home offsets come from the panels' own CSS — including the calc()/min()
 * cluster math in the mobile media queries — by reading the computed value with
 * the inline override cleared. So this stays correct at any width without
 * duplicating those expressions.
 */

const GAP        = 10;   // between a panel and the cluster, and between panels
const TOP_MARGIN = 12;   // never let a panel touch the top edge
const SIDE_MARGIN = 12;  // ...or the right edge
const Z_BASE     = 9000; // panels; the newest sits one above the older
const Z_BUTTON   = 9100; // buttons ride above every panel as a safety net

/** @type {Array<{id:string, panel:HTMLElement, button:HTMLElement, seq:number}>} */
const panels = [];

/**
 * Extra elements that belong to the BUTTON CLUSTER without being panels —
 * P55's RECENTER popup is the first. It is attached to the GYRO button, one
 * button wide, and shows and hides with it; a panel coming home has to clear it
 * exactly as it clears the buttons themselves.
 *
 * It is deliberately not registered as a panel. The rule above resolves TWO open
 * panels; a third would fall out of the `[first, second]` destructuring and be
 * left wherever it was, which in practice pushed the CO-OP panel off the right
 * edge of a 390px phone. Saying what a thing IS — cluster furniture, not a
 * panel — fixes that without weakening a rule that is correct for panels.
 */
const clusterExtras = [];

/** Count an element as part of the bottom-left cluster while it is visible. */
export function registerClusterMember(el) {
  if (el && !clusterExtras.includes(el)) { clusterExtras.push(el); schedule(); }
}
let seqCounter = 0;
let applying = false;    // guards the observer against our own style writes
let scheduled = false;

/**
 * Register a panel and the button that opens it. Order of registration does not
 * matter; open order does.
 */
export function registerPanel({ id, panel, button }) {
  if (!panel || !button) return;
  if (panels.some((p) => p.id === id)) return;

  button.style.zIndex = String(Z_BUTTON);
  panels.push({ id, panel, button, seq: 0 });

  const obs = new MutationObserver(() => { if (!applying) schedule(); });
  obs.observe(panel, { attributes: true, attributeFilter: ['style', 'class'] });

  // A viewport change can turn a fitting arrangement into a non-fitting one.
  if (panels.length === 1) {
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
  }
  schedule();
}

function isOpen(p) {
  return p.panel.style.display !== 'none' && p.panel.style.display !== '';
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  // Coalesce: a single click can flip both panels (open one, close the other),
  // and laying out on the intermediate state would place a panel we are about
  // to move again.
  requestAnimationFrame(() => { scheduled = false; layout(); });
}

/** Recompute and apply. Safe to call at any time. */
export function layout() {
  if (!panels.length) return;

  // Stamp an open sequence so "most recent" is well defined.
  for (const p of panels) {
    if (isOpen(p) && !p.seq) p.seq = ++seqCounter;
    if (!isOpen(p)) p.seq = 0;
  }

  const vh = window.innerHeight;
  const vw = window.innerWidth;

  // The button cluster: the union of every registered toggle, in bottom-offset
  // space (distance from the viewport's bottom edge).
  let clusterTop = 0;
  for (const p of panels) {
    const r = p.button.getBoundingClientRect();
    if (r.height) clusterTop = Math.max(clusterTop, vh - r.top);
  }
  for (const el of clusterExtras) {
    const r = el.getBoundingClientRect();   // 0-height while hidden, so it only counts when shown
    if (r.height) clusterTop = Math.max(clusterTop, vh - r.top);
  }
  const homeBottom = clusterTop + GAP;

  const open = panels.filter(isOpen).sort((a, b) => a.seq - b.seq);
  if (!open.length) return;

  applying = true;
  try {
    // Home left comes from each panel's OWN css, with our inline value cleared
    // so the media-query cluster math is what we read.
    for (const p of open) p.panel.style.left = '';
    const homeLeft = open.map((p) => parseFloat(getComputedStyle(p.panel).left) || 16);
    const size = open.map((p) => p.panel.getBoundingClientRect());

    if (open.length === 1) {
      place(open[0], homeLeft[0], homeBottom, Z_BASE);
      return;
    }

    // Two open: [0] was open first and keeps home, [1] is displaced.
    const [first, second] = open;
    const stackTop = homeBottom + size[0].height + GAP + size[1].height;
    const sideRight = homeLeft[0] + size[0].width + GAP + size[1].width;
    const tallest = Math.max(size[0].height, size[1].height);

    if (stackTop + TOP_MARGIN <= vh) {
      place(first,  homeLeft[0], homeBottom, Z_BASE);
      place(second, homeLeft[0], homeBottom + size[0].height + GAP, Z_BASE + 1);
    } else if (sideRight + SIDE_MARGIN <= vw && homeBottom + tallest + TOP_MARGIN <= vh) {
      place(first,  homeLeft[0], homeBottom, Z_BASE);
      place(second, homeLeft[0] + size[0].width + GAP, homeBottom, Z_BASE + 1);
    } else {
      // FALLBACK: the newest wins the space, the older collapses to its button.
      place(second, homeLeft[1], homeBottom, Z_BASE + 1);
      first.panel.style.display = 'none';
      first.seq = 0;
      console.log(`[panels] no room for both — "${first.id}" collapsed to its button`);
    }
  } finally {
    // Release the guard only after the browser has taken our writes, so the
    // observer does not re-enter on the mutations we just made.
    requestAnimationFrame(() => { applying = false; });
  }
}

function place(p, left, bottom, z) {
  p.panel.style.left = `${Math.round(left)}px`;
  p.panel.style.bottom = `${Math.round(bottom)}px`;
  p.panel.style.top = 'auto';
  p.panel.style.right = 'auto';
  p.panel.style.zIndex = String(z);
}

// Diagnostic surface. Exposed in dev so a headless check can read the measured
// boxes rather than inferring them from a screenshot.
if (import.meta.env.DEV) {
  window.__panelLayout = { layout, describeLayout: () => describeLayout() };
}

/** Test/diagnostic hook: the measured state of every registered panel. */
export function describeLayout() {
  const vh = window.innerHeight;
  return panels.map((p) => {
    const pr = p.panel.getBoundingClientRect();
    const br = p.button.getBoundingClientRect();
    return {
      id: p.id,
      open: isOpen(p),
      seq: p.seq,
      z: Number(p.panel.style.zIndex) || null,
      panel: isOpen(p)
        ? { left: Math.round(pr.left), top: Math.round(pr.top),
            right: Math.round(pr.right), bottom: Math.round(pr.bottom),
            width: Math.round(pr.width), height: Math.round(pr.height),
            cssBottom: Math.round(vh - pr.bottom) }
        : null,
      button: { left: Math.round(br.left), top: Math.round(br.top),
                right: Math.round(br.right), bottom: Math.round(br.bottom) },
    };
  });
}
