# P56 — HUD balance pass

Measured over CDP at exact viewports (2x DPR); numbers in `measurements.json`.
"Before" figures are the same harness run against main (P55) with the changes stashed.

## 1 — SHOOT: lower, and a little smaller

| | before (P55) | after (P56) |
|---|---|---|
| circle | 92 px | **84 px** |
| target glyph | 66 px | **60 px** |
| label | 13 px | **12 px** |
| bottom offset, **portrait** | 90 px | **16 px** (74 px lower) |
| bottom offset, **landscape** | 24 px | **10 px** (14 px lower) |

Portrait now shares the HUD grid's baseline exactly — both at `bottom: 16` — so the
bottom corners read as one row instead of two unrelated controls. Landscape keeps
its own, lower value: the viewport is ~390 px tall there, the grid already takes
110 px of it, and the thumb falls lower on a phone held sideways.

84 px is still nearly double the 44 px minimum touch target.

## 2 — No overlap, still

| viewport | grid right | SHOOT left | gap | button overlaps |
|---|---|---|---|---|
| 390 x 844 | 274 | 286 | **12 px** | 0 |
| 414 x 896 | 298 | 310 | **12 px** | 0 |
| 1280 x 800 | 356 | 1176 | **820 px** | 0 |
| 844 x 390 (landscape) | 356 | 740 | **384 px** | 0 |

The 12 px guarantee holds because it is *measured*, not assumed: a smaller SHOOT
moves `SHOOT.left` right, so the grid simply grew into the space — its buttons went
from 79.3 px wide to **82** px at 390. SHOOT never overlaps the grid at any width.

## 3-5 — SCORE and SESSION

| | before | after |
|---|---|---|
| SESSION | 13 px, **700 throughout** | **14 px**, word **400** / value **700** |
| SCORE | 16 px, single weight | **14 px**, word **400** / value **700** |
| same size? | no (13 vs 16) | **yes — both 14 px monospace** |
| SCORE top | 44 px | 40 px |

Both are built by one exported helper (`setReadout` in `hud.js`) so the pair cannot
drift apart. The session code is written with `textContent`, never interpolated into
markup — it arrives from the network.

## 2 (cont.) — RAPID FIRE aligned to that column

| | before | after |
|---|---|---|
| box, phone | 160 x 62 px | **129 x 38 px** |
| box, desktop/landscape | 183 x 70 px | **140 x 40 px** |
| title / sub | 18 / 12 px (14 / 10 on phone) | **14 / 10 px** (13 / 9 on phone) |
| padding | 14 x 22 px (9 x 12 phone) | **6 x 12 px** (6 x 10 phone) |
| vertical span vs top-left column | 16..86 vs 16..63 — 23 px overhang | **16..56 vs 16..56 — exact** |

Line-heights are now explicit, so the height is arithmetic rather than whatever the
font's default leading gives: 6 + 14 + 2 + 10 + 6 + 2 border = 40 px. Its top edge is
the SESSION chip's and its bottom edge is the SCORE line's — the two top corners span
the same band.

## 6 — X close

| panel | text | aria-label | radius | box | focusable |
|---|---|---|---|---|---|
| CO-OP | `X` | `Close` | 0px | 24 x 24 | yes (`<button>`) |
| WORLD | `X` | `Close` | 0px | 24 x 24 | yes (`<button>`) |

Themed per world — measured `rgb(0,229,255)` Classic, `rgb(232,182,88)` Gold,
`rgb(193,18,31)` Carnivorous. Both use the identical rule; two panels that open into
the same corner should not dismiss in two different ways.

## 7 — Motion re-grant

Traced end-to-end with a stubbed permission, counting real calls:

| tap | requestPermission calls | GYRO on | ALLOW MOTION | hint |
|---|---|---|---|---|
| 1st GYRO tap, denied | 1 | no | shown | — |
| ALLOW MOTION, denied again | 2 | no | shown | shown |
| ALLOW MOTION again | 3 | no | shown | shown |
| ALLOW MOTION, now granted | 4 | **yes** | hidden | cleared |

The live request is attempted on **every** tap — the count rises each time, so a
permission restored in Settings is picked up without a reload, and our own pessimism
is never cached. The hint only appears once a tap has come back refused a *second*
time, i.e. once there is evidence iOS is no longer showing a dialog. GYRO turns on
only when `enable()` actually resolved to a live sensor; there is no false-granted
state at any point.

The gyro needs `deviceorientation`, so the call is `DeviceOrientationEvent.requestPermission()`
(falling back to `DeviceMotionEvent.requestPermission` where only that exists). On iOS
both are the same "Motion & Orientation Access" grant; asking through both would risk
two dialogs for one permission.

## Contrast (WCAG, vs the world's panelBg — the P55 convention)

| world | HUD label | active label | SCORE | SESSION |
|---|---|---|---|---|
| classic | 15.78:1 | 11.25:1 | 8.79:1 | 14.52:1 |
| gold-arena | 15.6:1 | 10.95:1 | 10.7:1 | 12.84:1 |
| carnivorous | 15.64:1 | 14.16:1 | 5.44:1 | 5.74:1 |

Global minimum **5.44:1** against a 4.5 requirement.

One token changed to get there: the SESSION chip reads `--ui-primary-bright` rather
than `--ui-primary`. Carnivorous's primary is a deliberately dark blood red and
measured **3.24:1** as text on that world's panel; the bright variant — which
`theme.js` already derives for exactly this case, the primary hue used as text —
measures 5.74:1. The chip's halo stays full primary; a glow is not the thing you read.

## Two things the critique pass changed

1. **A restore race.** `enable()` is async, so a player who tapped GYRO while the
   session restore was still in flight had their choice overwritten a moment later by
   a promise that started before they pressed anything. The restore now stands down
   once the control has been touched.
2. **The blocked button didn't look blocked.** A red ALLOW MOTION popup sat under a
   GYRO button styled exactly like its neighbours. Its border and icon now take the
   danger colour; the label keeps the theme text colour, as in every other state.

## Not verifiable headlessly

The real iOS permission dialog (stubbed), actual gyro motion, and a live Lightning
session — SESSION and RAPID FIRE are made visible by a fixture that forces visibility
only. Their span structure is byte-identical to what `setReadout()` builds and every
measured number comes from the app's own stylesheet.
