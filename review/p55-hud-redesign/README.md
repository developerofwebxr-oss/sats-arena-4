# P55 — HUD redesign

Screenshots here are captured over CDP at exact viewports (2x DPR), with the
Definition-of-Done numbers measured from the same live page — `measurements.json`.

## Definition of Done

| # | item | result |
|---|---|---|
| 1 | Equal sizes at 390 / 414 / 1280 | **PASS** — see below; width and height spread **0.0 px** at every width |
| 2 | No overlap (grid↔SHOOT ≥12px, buttons, open panels) | **PASS** — gap exactly **12 px** on phones, 812 px desktop; 0 button overlaps; panels clear of grid, SHOOT and each other at all three widths, nothing off-screen |
| 3 | Sharp — computed `border-radius: 0px` | **PASS** — 0 exceptions across all 14 captures. Deliberate non-members: round SHOOT reticle, loading spinners, co-op knock dot (see HUD-STYLE.md) |
| 4 | No emoji in HUD markup/strings | **PASS** — 0 in rendered HUD text; sources swept (`⚡ RAPID FIRE`, `⚡ PAY 21 SATS`, `⚡ OPEN IN WALLET`, `✓ COPIED`, `👥 CO-OP`, `🎨 SKIN`, `🎙/🔴 MUTE`, `✓/✗`, `✕`, `⚔ COMPETE`, `⚡ Enable Motion Controls`, `⟲`) |
| 5 | Contrast ≥ 4.5:1 in all three worlds | **PASS** — minimum **10.95:1** |
| 6 | Tooltip: 2s auto-dismiss, outside tap, one at a time | **PASS** — measured at 390 and 414 |
| 7 | GYRO on/off, permission on the tap, session persistence | **PASS** — permission requested exactly once, on the tap |
| 8 | No user-visible "SKIN" string | **PASS** — 0 matches in rendered text, all 14 captures |
| 9 | Theming follows the world | **PASS** — grid, icons, tooltip and popup recolour; danger unchanged |
| 10 | Screenshots + design critique | **PASS** — 14 captures; three fixes made, listed below |

## Item 1 — measured button boxes

| viewport | button | width spread | height spread | grid width |
|---|---|---|---|---|
| 390 px | **79.3 x 44 px** (6 buttons) | 0 px | 0 px | 250 px |
| 414 px | **87.3 x 44 px** (6 buttons) | 0 px | 0 px | 274 px |
| 1280 px | **109.3 x 44 px** (5 buttons) | 0 px | 0 px | 340 px |

GYRO is hidden at 1280 (no gyroscope), so the top row is two buttons in tracks 1
and 2 with track 3 left empty — the grid itself is unchanged.

## Item 2 — clearances

| viewport | grid right | SHOOT left | gap |
|---|---|---|---|
| 390 px | 266 | 278 | **12 px** |
| 414 px | 290 | 302 | **12 px** |
| 1280 px | 356 | 1168 | **812 px** |

## Item 5 — contrast (WCAG, label vs the HUD surface)

| world | label on panelBg | active label on the 18% fill |
|---|---|---|
| classic | 15.78:1 | 11.25:1 |
| gold-arena | 15.6:1 | 10.95:1 |
| carnivorous | 15.64:1 | 14.16:1 |

No world needed its `text` token adjusted.

## What the design critique changed

Three things were built, looked at, and rebuilt:

1. **The tooltip landed on the top row.** "Above the button" taken literally puts
   it 8px over the VR button — which is the lower of two rows, so it covered
   WORLD and GYRO. It now clears the whole cluster and stays centred on the
   button it explains.
2. **A literally transparent fill was unreadable.** Over Classic's lit cyan floor
   the 12px label disappeared, and a contrast figure against "whatever the arena
   is rendering" is not a figure. The buttons sit on the shared `panelBg` token;
   "outlined" means no primary tint. See HUD-STYLE.md.
3. **The active label recoloured to `primary` measured 2.93:1 in Carnivorous** —
   blood-red text on a blood-red wash. The label now keeps the theme text colour
   in every state; the active signal is the fill, the border, the glow and a
   primary icon. Minimum contrast went from 2.93 to 10.95.

Plus one consistency fix the screenshots surfaced: the CO-OP panel closed with a
15px glyph and the WORLD panel with a 9px tracked word. They now match.

## Notes

* The RECENTER popup is registered with P43 as **cluster furniture**, not as a
  panel. Registering it as a third panel was tried first and broke P43's
  two-panel rule — the third fell out of the `[first, second]` resolution and
  shoved the CO-OP panel off the right edge of a 390px screen.
* `hud-grid.js` re-measures SHOOT on a ResizeObserver plus a settle burst, not
  once at setup — the same watchdog lesson `scene.js` already carries.
* Not verifiable headlessly: the real iOS motion-permission dialog (stubbed to
  `granted`), actual gyro motion, and the VR/AR buttons in their supported state.
