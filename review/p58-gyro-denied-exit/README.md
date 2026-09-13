# P58 — the GYRO denied state was a trap

`checks.json` holds the 19 assertions; every one is measured against the real
code in CDP mobile emulation with real touch events.

## Root cause

Two faults, both in the denied state P56 introduced.

**1. `gyroDenied` was a one-way latch.** The GYRO click handler had exactly two
branches — "it's on, turn it off" and "it's off, request permission". There was
no branch for "the denied panel is showing". Nothing cleared the flag except a
*successful* enable, and on an origin where iOS has remembered a refusal a
successful enable is precisely what can never happen. There was no X, and the
outside-tap listener only ever touched the tooltip. Measured against the shipped
code with a permission that resolves `'denied'` immediately:

```
after tap 1   denied=true  popup=block  allow=true  hasX=false  permCalls=1
after tap 2   denied=true  popup=block  allow=true  hasX=false  permCalls=2
after tap 3   denied=true  popup=block  allow=true  hasX=false  permCalls=3
after tap 4   denied=true  popup=block  allow=true  hasX=false  permCalls=4
after tap 5   denied=true  popup=block  allow=true  hasX=false  permCalls=5
after outside tap — unchanged
```

A state the game can enter and not leave is not a state.

**2. The panel could not tell the two refusals apart.** iOS remembers a denial
per origin: every later `requestPermission()` resolves `'denied'` with no dialog
at all. P56 showed a red ALLOW MOTION button that re-fired exactly that request,
so the button did nothing, visibly, forever — and the explanatory hint only
appeared on the *second* tap, by which point the player had already concluded the
control was broken.

## The fix

**Always an exit — four of them.** `dismissBlocked()` closes the panel and returns
to plain finger-drag look:

| path | how |
|---|---|
| the X | a 30px button in the panel, `aria-label="Close"` |
| tapping GYRO again | the branch that was missing |
| tapping anywhere else | `pointerdown`, capture phase |
| dragging to look | the same `pointerdown` — you dismiss it by playing |

**`pointerdown`, not `click`, and that is not a detail.** `input.js` calls
`preventDefault()` on a touchend that lands on the canvas, to stop the synthetic
click double-firing a shot. So a finger tap on the *game* — by far the most
likely "somewhere else" — produces no click event at all. The first version of
this fix used `click` and measured exactly that: the X and the GYRO tap closed
the panel, an outside tap did not. `pointerdown` fires for mouse and touch alike
and nothing suppresses it.

**Which refusal was it? Measure, don't guess.** A dialog costs human time; a
remembered denial comes back in single-digit milliseconds. `requestMotion()`
times the request and picks the wording from it (`SILENT_REFUSAL_MS = 250`):

| outcome | what the panel says |
|---|---|
| granted | — GYRO turns on, panel becomes RECENTER |
| refused, **no dialog** (< 250 ms) | "Safari won't ask again. Turn on Motion & Orientation Access in Settings > Apps > Safari, then clear this site's data." |
| refused **after a dialog** | "Motion access declined. Try again, or turn it on in Settings > Apps > Safari." |

The red dead-button state is gone: the panel leads with the hint, and TRY AGAIN
sits under it as an ordinary control. TRY AGAIN re-runs the **live** request every
time, because the player may have gone to Settings in between — granted turns GYRO
on immediately, with no reload.

**Nothing persisted that can re-trap.** `rememberGyro(true)` moved to the success
branch, so a refused attempt no longer records an intent it did not achieve. P57's
rule is untouched: the boot restore still calls `enable({ prompt: false })` and
never asks gesture-lessly.

## Verification — 19/19

Real `Input.dispatchTouchEvent` taps under 390x844 mobile emulation, against a
`requestPermission` that returns `'denied'` with no dialog — the shape that hid
the earlier bugs is explicitly not used.

| | |
|---|---|
| silent denial opens the panel | PASS |
| panel offers TRY AGAIN and X | PASS |
| hint says the browser won't ask again | PASS |
| panel covers neither the grid nor SHOOT, stays on screen | PASS |
| drag-look works **while blocked** | PASS |
| a canvas drag also dismisses it (pointerdown) | PASS |
| X dismisses / re-opens after X | PASS |
| GYRO tap dismisses / re-opens again | PASS |
| outside tap dismisses | PASS |
| drag-look works after dismissal | PASS |
| **10 open/close cycles never trap** | PASS |
| TRY AGAIN after enabling in Settings turns GYRO on | PASS |
| and motion drives the camera, no reload | PASS |
| declined-via-dialog gets the other wording | PASS |
| the dialog case is dismissible too | PASS |
| reload comes back clean, not blocked, zero permission calls | PASS |
| drag-look works on the fresh load | PASS |

Screenshots: `denied-silent-classic.png` (the hint with its TRY AGAIN and X, GYRO
marked in danger red, clear of the grid and SHOOT), `denied-dialog-carnivorous.png`
(the other wording, themed), `recovered-after-grant.png`.

## Not verifiable headlessly

A physical iPhone's dialog and its remembered-denial bookkeeping. The model used
here — `'denied'` resolved immediately with no dialog — is the documented shape of
that state, and it reproduced the trap exactly before the fix.
