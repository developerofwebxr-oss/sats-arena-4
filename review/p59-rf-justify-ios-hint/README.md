# P59 — RAPID FIRE full-justified; the iOS hint corrected

## 1 — The sub-line spans the title, end to end

"21 sats · 60s" now sits exactly under "RAPID FIRE": the **2** flush under the
**R**, the final **s** flush under the **E**.

**How.** The box shrinks to its widest line, which is the title, so the sub-line
is a flex row whose width *is* the title's, and `justify-content: space-between`
spreads its three parts across it. No measured pixel is copied anywhere, which is
why it holds at the phone's 13/9 px and the desktop's 14/10 px without a
breakpoint.

**The part that makes it exact rather than close.** `letter-spacing` is applied
*after* every character, the last one included, so each line's box ends one
tracking-width past its final glyph — and the title (0.12em of 14px = 1.68px) and
the sub-line (0.12em of 10px = 1.2px) overshoot by *different* amounts. Aligning
the boxes would leave the "s" visibly short of the "E". A negative right margin of
exactly one tracking on the title and on "60s" cancels it on both, so what aligns
is where the glyphs end.

**Measured at the glyph edges**, not the boxes — a `Range` around each text node,
minus that node's trailing tracking:

| viewport | title / sub | title left | sub left | Δ left | title right | sub right | Δ right |
|---|---|---|---|---|---|---|---|
| 390 px | 13px / 9px | 268.67 | 268.67 | **0** | 360.99 | 361 | **0.01** |
| 414 px | 13px / 9px | 292.67 | 292.67 | **0** | 384.99 | 385 | **0.01** |
| 1280 px | 14px / 10px | 1151.58 | 1151.58 | **0** | 1250.99 | 1250.99 | **0** |

Requirement ±1 px; worst case **0.01 px**. The box still ends on the SCORE line,
so P56's corner alignment is intact.

## 2 — The hint no longer sends people to a setting that doesn't exist

The P58 copy said "turn on Motion & Orientation Access". **That Safari toggle was
removed in iOS 13** and is not on iOS 16, 17 or 18 — the owner looked and could
not find it. On a current iPhone motion permission is asked per site and a refusal
is remembered per site, so the only real recovery is deleting the site's website
data, which is what lets the prompt return.

| refusal | lead | instruction |
|---|---|---|
| no dialog shown | **Safari won't ask again.** | Settings › Apps › Safari › Advanced › Website Data › delete this site, then reload and tap GYRO. |
| dialog declined | **Motion access declined.** | Try again. If it stops asking, delete this site's data in Safari's Website Data settings. |
| both, muted | | Must be Safari — Chrome and in-app browsers keep motion and site data in their own settings. |

The breadcrumb uses `›` throughout rather than `→`: U+2192 sits in the arrow range
P55's no-emoji gate rejects, and `›` reads as the same path. The lines are built
from DOM nodes rather than `innerHTML`. TRY AGAIN, the X and the live request on
every TRY AGAIN tap are unchanged.

## Verification

**27/27** P59 checks at 390, 414 and 1280: both edges within ±1 px at every width;
box still on the SCORE line; the corrected hint shown, no mention of the removed
toggle, the Safari note present; **no overflow** — the hint's box and each of its
lines checked for `scrollWidth > clientWidth` and against the popup's edges; panel
on screen and clear of the grid and SHOOT; TRY AGAIN fires the live request again;
X closes; GYRO re-open/close never traps.

Every earlier GYRO suite re-run against this build:

| suite | result |
|---|---|
| P58 denied-state | 19/19 |
| P58b prompt / landscape | 14/14 |
| P57 platform scenarios | 10/10 |

P57's suite first came back 1/10, and it was the probe, not the product: it read
`#gyro-allow`'s own computed `display`, but since P58 that button lives inside
`#gyro-block`, which is the element that gets hidden. A child's computed display
does not reflect a hidden ancestor — measured `ownComputedDisplay: flex`,
`parentDisplay: none`, `actuallyRendered: false`. Switched to `checkVisibility()`:
10/10, with active, motion, listener count and permission calls unchanged in every
row.

Screenshots: `rapidfire-390.png`, `rapidfire-1280.png`, `hint-390.png`, `hint-414.png`.

---

## 3 — RECENTER matches GYRO (fast-follow, same branch)

**First, a regression of mine.** P58 (`863fccf`) deleted RECENTER's style rule.
Rewriting the denied-panel CSS, I replaced a block that also held
`#recenter-go, #gyro-allow {…}` and `#recenter-go:hover`; from then on RECENTER
rendered as a bare browser button with only the sharp-corner rule applying. That
is the "differently-styled pill" the owner saw. The P58b/P59 suites tested
RECENTER's visibility and overlaps but never its styling, which is how it shipped.

**The fix makes it structurally impossible to repeat.** RECENTER now carries the
grid's own `.hud-btn` class — the one rule every grid button uses for the 1.5px
primary border, sharp corners, panelBg surface, theme text colour, uppercase
monospace label and hover glow — instead of a hand-copied set of the same
declarations. Only two things are overridden, both as the owner asked: height
(36px) and type size (11px).

Its width comes from GYRO's **measured** box, unrounded, rather than from column
arithmetic — which only agreed with it to within the rounding a `1fr` track and a
`Math.round()` on `left` each introduced.

| viewport / world | RECENTER | GYRO | Δ width | edges |
|---|---|---|---|---|
| 390 × all three | 82 × 36 @ 192..274 | 82 @ 192..274 | **0.00** | identical |
| 414 × all three | 90 × 36 @ 208..298 | 90 @ 208..298 | **0.00** | identical |
| 1280 × all three | 109.34 × 36 @ 246.66..356 | 109.34 @ 246.66..356 | **0.00** | identical |

(1280 is emulated with touch — on a non-touch desktop GYRO and RECENTER don't exist.)

**93/93 checks** across 3 widths × 3 worlds: visible with GYRO on; width and both
edges within ±1px; sits directly above GYRO; border identical to the grid buttons
and this world's primary; sharp on all four corners; surface, label colour,
family, weight, uppercase and tracking identical to a grid button; 36px tall with
11px letters; clear of the grid and SHOOT; CO-OP and WORLD opening still hide it,
and it returns when CO-OP closes.

Two notes on how parity was measured, because the first run's strict assertions
failed for reasons that aren't differences:

* **Border.** `--hud-border-w` is `1.5px`; at this emulated device scale Chromium
  reports the rendered border as `1px` for *every* HUD button, RECENTER and grid
  alike. Parity is asserted as RECENTER == grid button, plus the token itself.
* **Tracking.** Both labels are `0.08em`. RECENTER's is 0.88px and a grid label's
  is 0.96px (1.04px at desktop) only because RECENTER keeps its smaller 11px
  letters — 0.88/11 = 0.96/12 = 1.04/13 = 0.08. Parity is asserted in em.

Every earlier suite re-run against this build: P59 27/27, P58 19/19, P58b 14/14,
P57 10/10.

Screenshots: `recenter-390-classic.png`, `recenter-390-gold-arena.png`,
`recenter-390-carnivorous.png`.
