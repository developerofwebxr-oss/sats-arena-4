# P57 — GYRO dead on mobile

`node scenarios` output in `scenarios.json`; the ON/RECENTER/OFF trace with camera
quaternions in `trace.json`.

## Root cause: the session restore asked for permission with no user gesture

There are two, and both come from one line — P55's session restore, which called
`gyroApi.enable()` at page load:

```js
if (sessionStorage.getItem('hudGyro') === 'on') {
  gyroApi.enable().then(...)          // ← at load. No gesture behind it.
}
```

`enable()` unconditionally called `DeviceOrientationEvent.requestPermission()`.

**Cause 1 — iOS, and this is the fatal one.** A gesture-less `requestPermission()`
is not a harmless failure on iOS: Safari **spends the page load's one chance on
it**. The tap that follows is then refused *before the dialog is ever shown*, and
because the refusal is remembered, so is every tap after that. The effect is
sticky and self-inflicted: the moment a player had ever switched GYRO on —
writing `hudGyro='on'` — every subsequent load poisoned itself at boot, and the
button could never be turned on again.

Measured against the shipped code, modelling iOS faithfully (a call only succeeds
with `navigator.userActivation.isActive`, and a gesture-less call poisons the page):

| scenario | permission calls | listener attached | camera moved |
|---|---|---|---|
| fresh, 1 tap | `["gesture"]` | 1 | **yes** |
| returning (`hudGyro='on'`), 1 tap | `["NO-GESTURE","gesture"]` | **0** | **no** |
| returning, 2 taps | `["NO-GESTURE","gesture","gesture"]` | **0** | **no** |
| returning, 3 taps | `["NO-GESTURE","gesture","gesture","gesture"]` | **0** | **no** |

Never, at any number of taps. That is the reported "does not work at all".

**Cause 2 — Android / anything with no permission gate.** The same restore
*succeeds* silently at load, because there is nothing to ask for. The button came
up ON without the player asking for it, so their first tap turned it OFF — an
apparently inverted, apparently dead toggle.

### Why P56's test missed it

P56 stubbed `requestPermission` to resolve `'granted'` unconditionally and counted
calls. A stub that always grants cannot model the one behaviour that mattered —
that a call made *without* a gesture is remembered and poisons the next one — and
counting calls says nothing about whether a `deviceorientation` listener was ever
attached or whether the camera moved. Every check in this pass asserts the
listener count and the camera's actual response instead, and one assertion is
simply: **no automatic code path may ever ask.**

## The fix

`enable()` takes `prompt`, and only a real tap may pass `true`:

```js
async enable({ prompt = true } = {}) {
  const ask = permissionGate();          // null where there is nothing to ask
  if (!ask) return install();            // Android: just turn it on
  if (!prompt) return false;             // would have to ask, and may not — stay off
  try { if (await ask() !== 'granted') return false; } catch { return false; }
  return install();
}
```

* The restore calls `enable({ prompt: false })`. It resumes where no permission is
  needed, and on iOS simply leaves the toggle off and waits for a tap — because
  only a tap may legally ask.
* `permissionGate()` prefers `DeviceOrientationEvent.requestPermission` and falls
  back to `DeviceMotionEvent.requestPermission` where only that exists. It never
  asks through both: on iOS they are the same grant, and asking twice risks two
  dialogs for one permission.
* `renderGyro()` no longer writes `sessionStorage`. It used to write on *every*
  render — including the one during boot, before an async restore could resolve —
  so a load that could not resume silently erased the very intent it was trying to
  restore. The intent is now written only from the tap handlers, by
  `rememberGyro()`, so "I want motion look" survives a reload that was not allowed
  to ask yet.

Nothing else moved: the P56 HUD and layout, the re-grant affordance, and the
desktop behaviour (GYRO hidden, no controller built) are untouched.

## Verification — the real code paths, no always-grant stub

10/10 scenarios pass, across both platform shapes. Every row asserts the
`deviceorientation` listener count and whether the camera actually moved, and
every row asserts that nothing automatic asked for permission.

| scenario | permission calls | listener | active | camera |
|---|---|---|---|---|
| iOS fresh, 1 tap | `["gesture"]` | 1 | on | **moves** |
| **iOS returning, 1 tap** | `["gesture"]` | 1 | on | **moves** |
| iOS returning, 2 taps | `["gesture"]` | 1 | off | ignored |
| iOS returning, 3 taps | `["gesture","gesture"]` | 1 | on | **moves** |
| iOS double-click in one gesture | `["gesture","gesture"]` | 1 | on | **moves** |
| iOS refuses | `["call"]` | 0 | off | — (ALLOW MOTION shown) |
| Android fresh, 1 tap | `[]` | 1 | on | **moves** |
| Android returning, no tap | `[]` | 1 | on | **moves** |
| Android returning, 1 tap | `[]` | 1 | off | ignored |
| Android returning, 2 taps | `[]` | 1 | on | **moves** |

Taps are real CDP touch events (`Input.dispatchTouchEvent`) under device
emulation, not `element.click()` — so the click binding, `touch-action` and the
user-activation window are all exercised the way a finger exercises them.

### Camera actually driven by orientation (Classic and Carnivorous)

`trace.json`; quaternions after each synthetic `deviceorientation`:

```
after GYRO on, before any orientation event  q=[-0.09983, 0, 0, 0.995]
orientation alpha=0   beta=90                q=[-0.0001, 0, 0, 1]
orientation alpha=90  beta=90                q=[0, 0.70711, 0, 0.70711]
orientation alpha=180 beta=60                q=[0, 0.96593, 0.25882, 0]
orientation alpha=270 beta=75 gamma=15       q=[0.07946, 0.60355, 0.10355, -0.78657]
```

* **RECENTER still works**: after tapping it and re-firing the same orientation,
  the camera returns to neutral — `q=[0, 0, 0, -1]`.
* **OFF**: button inactive, popup hidden, further orientation events **ignored**
  (`orientationIgnored: true`), and a finger drag on the canvas moves the camera
  again (`dragLookWorks: true`).

The listener is *gated* rather than removed on OFF. Removing and re-adding it per
toggle would stack a second listener and a second slerp writing the same camera
the first time a re-enable raced an add; one listener whose single gate is
`gyroEnabled` is the same behaviour with one writer. The evidence that it is
equivalent is the measured `orientationIgnored: true` above.

Screenshots: `classic-gyro-on.png`, `carnivorous-gyro-on.png` (camera rotated by
orientation, GYRO active, RECENTER up), and `*-gyro-off-dragged.png`.

## Not verifiable headlessly

A physical iPhone's real permission dialog and real sensor. The iOS model used
here is a faithful reconstruction of the documented behaviour — gesture-required,
and a gesture-less call remembered for the page load — and it reproduced the
reported symptom exactly before the fix and passes after it.
