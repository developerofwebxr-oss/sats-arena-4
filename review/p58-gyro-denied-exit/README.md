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

---

# P58b — owner follow-up: the prompt, the sub-line, landscape

## What the real permission difference was

The redirect asked me to route GYRO through the mechanism AR/VR use. **There
isn't one to route through on an iPhone.** Every permission request in the
codebase:

| what | API | on the owner's iPhone |
|---|---|---|
| VR / AR entry | `navigator.xr.requestSession(...)` | **unavailable** — Safari ships no WebXR, so `navigator.xr` is undefined and both buttons render "WebXR unavailable on your device" |
| co-op voice | `getUserMedia` (via LiveKit) | works, but it is the microphone permission and cannot grant motion |
| motion look | `DeviceOrientationEvent.requestPermission()` | the only motion API there is |

So AR/VR cannot be the flow that is "working on the same device" — those controls
are dimmed on that phone. The comparison that *is* available is the pre-toggle
gyro, and its call shape was:

```js
btn.addEventListener('click', async (e) => {
  e.stopPropagation();
  try {
    const response = await DeviceOrientationEvent.requestPermission();   // first statement
```

**The real difference is not the call shape — it is the origin's permission
state.** P55 called `requestPermission()` at page load with no gesture behind it.
iOS records that refusal for the origin, and from then on answers every later
call `'denied'` instantly, with no dialog, regardless of how correct the calling
code is. P57 stopped new installs being poisoned; **nothing in the page can
un-poison an origin that already is.** Only clearing the site's website data
can — which is why the hint now names that step explicitly, and why the owner
sees "shows the red panel, never re-prompts": that is the signature of a
remembered denial, not of a broken call.

The indirection was removed anyway, because it bought nothing and the owner is
right that it was the thing that changed. `permissionGate()` returned an arrow
function, called from an `async` method, called from another `async` function,
called from the handler. Every frame ran synchronously, so none of them *should*
have cost the gesture — but "should" is doing a lot of work in a sentence about
Safari's transient activation. `enable()` is now a plain (non-`async`) function
whose permission call is its first real statement, invoked straight from the tap:
the old shape, with P57's `prompt` flag as the only addition.

Verified on a phone that is **not** poisoned — the prompt fires from the tap with
`navigator.userActivation.isActive === true`, the listener attaches, the camera
follows orientation, and it **asks again on every subsequent enable**:

| check | result |
|---|---|
| boot asked for nothing | PASS (0 calls before the tap) |
| the tap prompts, with user activation | PASS (`act: true`) |
| granted → listener attached + GYRO on | PASS |
| the camera follows orientation | PASS |
| asks again on the next enable, over and over | PASS (2 calls after off→on) |

## Cosmetic 1 — the RAPID FIRE sub-line

| | before | after |
|---|---|---|
| markup | `21 sats &nbsp;·&nbsp; 60s` (two nbsp **plus** the literal spaces either side) | `21 sats<span>·</span>60s`, `margin: 0 3px` |
| tracking | `0.16em` | `0.12em` (**1.08px**) |
| box alignment | `text-align: center` | `text-align: left` |
| sub-line vs title left edge | drifted — centred lines of different tracking do not agree | **0.0 px** (both at x = 267.1, width 93.9) |

The bullet now has 3px either side instead of two non-breaking spaces plus
tracking, and the two lines share a left edge because the box stopped centring
them independently.

## Cosmetic 2 — the landscape rule

**A panel the player just opened outranks an attached popup.** When `#coop-panel`
or `#world-panel` opens, the GYRO popup stands down — RECENTER hides, and a
blocked hint is dismissed outright. When the last one closes, RECENTER comes
back. Restacking horizontally was the alternative and it is worse: it moves a
control mid-use. RECENTER is one tap from returning and the hint is dismissible
by design, so neither loses anything by yielding.

It is implemented as a `MutationObserver` on the panels' own `display` — the P43
lesson about watching the thing that actually changes rather than patching four
toggles. It binds on the first `refresh()`, not at setup: hud-grid is created
*before* coop-hud and skin-hud, so at setup the panels do not exist yet and the
observers attached to `null` (measured: the popup stayed up).

That alone was not enough. In landscape the CO-OP panel is taller than the ~260px
a ~390px viewport leaves above the cluster, so it grew straight through the
top-left readouts — measured, `coop-panel x score`. Both panels now carry
`max-height: calc(100dvh - 180px); overflow-y: auto`, where 180 is the arithmetic
of what is already on screen: 110 cluster + 10 P43 gap + 56 readouts + 4. In
portrait it evaluates to far more than either panel needs and changes nothing.

| landscape 844x390 | overlaps |
|---|---|
| GYRO on, RECENTER up | **none** |
| CO-OP open (popup stood down) | **none** |
| CO-OP closed again | RECENTER back, **none** |
| portrait 390x844, both panels open | **none** |

Screenshots: `b-prompting-portrait.png`, `b-rapidfire-subline.png`,
`b-landscape-coop-open.png`, `b-landscape-popup-back.png`,
`b-poisoned-hint-carnivorous.png`, `b-portrait-panels.png`.

**14/14** new checks plus **19/19** of the original P58 suite still passing.
