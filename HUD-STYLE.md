# HUD style tokens

One place, one set. Everything the flat/mobile HUD draws reads these; nothing
hard-codes a colour, a radius or a border width. They are declared on `:root` in
`src/hud-grid.js` and derive from the active world's palette (`src/theme.js`), so
switching worlds restyles the whole HUD with no repaint code.

| token | value | what it is |
|---|---|---|
| `--hud-radius` | `0` | **Sharp everywhere.** The brand rule. |
| `--hud-border-w` | `1.5px` | every HUD border |
| `--hud-border` | `var(--ui-primary)` | border colour |
| `--hud-bg` | `var(--ui-panel)` | the surface — the world's `panelBg` at 88% |
| `--hud-fill` | `var(--ui-primary-18)` | active fill: primary at 18% |
| `--hud-glow` | `0 0 8px var(--ui-primary-50)` | active/hover only — never at rest |
| `--hud-text` | `var(--ui-text)` | every label, in every state |
| `--hud-font` | `700 12px/1 monospace` (13px ≥769px) | uppercase labels |
| `--hud-track` | `0.08em` | letter-spacing |
| `--hud-btn-h` | `44px` | minimum touch target |
| `--hud-gap` | `6px` | between columns and between rows |
| `--hud-edge` | `16px` | from the left and bottom edges |
| `--hud-shoot-left` | measured | SHOOT's left edge, republished on every change |

`--ui-primary-18` and `--ui-primary-50` are derived in `theme.js` with the rest of
the alpha layer, so a world changing `primary` moves them together.

## Two treatments, one footprint

* **Mode buttons** (SCREEN / VR / AR) — label only.
* **Action buttons** (CO-OP / WORLD / GYRO) — an 18px inline SVG icon, then the
  label. Icons use `stroke="currentColor"` at 1.75px with round caps on an 18×18
  viewBox, so one unit is one CSS pixel and they stay crisp at 1× and 2×.
* **Active** (the current mode; GYRO while on) — `--hud-fill` over `--hud-bg`, a
  full-`primary` border, the glow, and a `primary` icon. **The label colour does
  not change.** Recolouring it to `primary` measured 2.93:1 in Carnivorous —
  blood-red text on a blood-red wash — and one label colour across all six
  buttons is what makes the row read as a set.
* **Unavailable** — 40% opacity, still tappable; the tap raises the tooltip.

### On "transparent fill"

The spec calls an inactive mode button "outlined — transparent fill". What that
means here is **no primary tint** — the border alone carries the state. The
button still sits on `--hud-bg`. A literally transparent fill was built first and
rejected: over Classic's lit cyan floor the 12px label disappeared, and "label
contrast ≥ 4.5:1" is not a measurable requirement against whatever the arena
happens to be rendering. The surface is the shared `panelBg` token, which §3 of
the spec names as part of this set.

## What is deliberately NOT sharp

`border-radius: 0` applies to the six buttons, the tooltip, the RECENTER popup,
score, session chip, the RAPID FIRE panel, toasts, the CO-OP and WORLD panels and
every input and button inside them.

It does **not** apply to the round SHOOT reticle, the loading spinners or the
co-op knock dot. Those are circles because of what they are — a sight, a
rotation, a dot — not because of a rounding style.
