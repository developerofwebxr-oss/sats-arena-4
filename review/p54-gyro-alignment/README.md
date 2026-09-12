# P54 — gyro alignment + RECENTER semantics

Reproduce the sweep: `node review/p54-gyro-alignment/gyro-sweep.mjs`

## Part A — which of the three causes was it?

**Cause 3, alone.** A yaw offset applied in the wrong frame. Causes 1 and 2 are
ruled out with numbers below.

The correction was `anchorInverse · device_now`, where `anchorInverse` was the
**full** inverse of whatever pose the phone was in when the gyro started. Nobody
holds a phone upright, so that inverse carried the holding **pitch and roll** as
well as the heading — and a full-3-DOF pre-rotation about an arbitrary axis is
not a heading correction. It is exact at the anchor heading and wrong everywhere
else, because the baked-in pitch stops lining up with the pitch axis the moment
you turn.

Holding the phone 15° back from upright (gamma 0), anchored facing forward:

| heading | 0 | 90 | 180 | 270 | spread |
|---|---|---|---|---|---|
| camera elevation | 0.00° | −14.48° | −30.00° | −14.48° | **30.00°** |
| camera roll | 0.00° | −15.50° | 0.00° | 15.50° | **31.00°** |

At 30° back the spreads double again (60.00° / 67.38°). The error is exactly
**2× the hold tilt at 180°** — turn around and the horizon moves a third of a
screen. Cross-checked against the running app (synthetic `deviceorientation`,
after the slerp settles): 0° → 0.00, 90° → −14.48, 180° → −30.00. Exact match.

### Cause 1 — a constant pitch bias Classic hides? No: not constant.

The math is shared, so the error **is** identical in every world — but it is
heading-dependent, not a fixed bias. What *is* skin-dependent is whether you can
see it. Measured with the camera forced perfectly level, the floor/wall seam:

| world | 0° | 90° | 180° | 270° | spread |
|---|---|---|---|---|---|
| classic | *no seam* | *no seam* | −6.09° | −6.09° | — |
| gold-arena | −6.06° | −5.78° | −6.06° | −5.78° | 0.28° |
| carnivorous | −5.95° | −6.00° | −5.88° | −5.91° | 0.12° |

Classic's seam **does not exist at two of the four headings** — its skyline sits
beyond the 30 × 30 radar floor, with void below the seam elsewhere. There is
nothing to read a 15° tilt against. Gold and Carnivorous are sealed rooms whose
seam is continuous and within 0.3° of level at every heading, so the same error
is legible instantly. Same bug, two of three worlds can show it.

### Cause 2 — arenas offset or tilted? No.

| world | root position | root rotation | root scale | floor y under the eye |
|---|---|---|---|---|
| classic | 0, 0, 0 | 0°, 0°, 0° | 1, 1, 1 | 0.000 |
| gold-arena | 0, 0, 0 | 0°, 0°, 0° | 1, 1, 1 | −0.045 |
| carnivorous | 0, 0, 0 | 0°, 0°, 0° | 1, 1, 1 | 0.000 |

No residual import rotation, no offset, no scale. Gold's floor sits 45 mm below
the rig's y=0, which puts the eye at 1.645 m — the 1.65 m reference camera its
own integration notes specify. All three seams agree within 0.3°. The arenas are
innocent; nothing was changed there.

## The change

`src/movement.js`, `setupGyro` only. The correction is now a rotation about
**world up** and nothing else:

```
camera = Ry(yawOffset) · deviceQuaternion_now
```

`yawAboutUp(q) = 2·atan2(q.y, q.w)` is the twist of `q` about world +Y. It is
exact, not approximate: pre-multiplying by a rotation of `t` about world up maps
`(w + i·y) → e^{it/2}·(w + i·y)`, so it returns exactly `t` more. Verified to
**1.02e-13°** over 20k random quaternions. Unlike reading yaw off the forward
vector it does not degenerate when you look straight up.

Pitch and roll are now never touched, so they are gravity-referenced at every
heading. Same sweep, after:

| heading | 0 | 90 | 180 | 270 | spread |
|---|---|---|---|---|---|
| camera elevation | −15.00° | −15.00° | −15.00° | −15.00° | **0.00°** |
| camera roll | 0.00° | 0.00° | 0.00° | 0.00° | **0.00°** |

The screen term (portrait vs landscape) stays post-multiplied and outside the
correction, exactly where it was — that structure was the earlier landscape fix
and is unchanged.

### Horizon heights, measured in the real scene (812 px tall, phone 15° back)

Screen row of the floor/wall seam along the direction the camera faces:

| | 0° | 90° | 180° | 270° | spread |
|---|---|---|---|---|---|
| **gold** before | 468 | 321 | 149 | 321 | **319 px** |
| **gold** after | 315 | 312 | 315 | 312 | **3 px** |
| **carnivorous** before | 466 | 322 | 146 | 323 | **320 px** |
| **carnivorous** after | 314 | 313 | 313 | 314 | **1 px** |

The 1–3 px residual is the arenas' own geometry (Gold is a rounded rectangle, so
its seam genuinely differs by 0.28° between the 0/180 and 90/270 axes), not the
camera. Screenshots: `before/after-{gold,carn}-h{0,90,180,270}.png`.

## Part B — RECENTER

`gyroRecenter` used to be `haveAnchor = false`, so the next reading re-anchored
at the current pose and the world swung until you were facing −Z again — the gate.
That is the reported head-turn, and it is a **180° swing** when pressed while
facing backward.

It now re-derives the yaw offset so the heading **currently on screen** is the
new neutral. With the correction constrained to world-up, the shown heading is
exactly `yawOffset + yawAboutUp(device)`, so solving for the offset that
reproduces it returns the offset already in use. **Recentering cannot move the
view — by construction, not by tuning.** Measured in the app, pressed while
facing backward:

```
before press   elev −15.00  roll 0.00  heading 180.0
after  press   elev −15.00  roll 0.00  heading 180.0
max quaternion component delta  0        heading moved  0.000°
(the old recenter, same moment: heading snaps 180° → 0°)
```

Turning 30° further afterwards takes the heading to 210° — relative motion
continues from the preserved neutral.

What recenter still does, and why it is not a dead button:

* establishes the neutral the **first** time, from the heading the player was
  already looking at with drag-look, so switching motion on is silent. Measured:
  drag-look to heading 55°, enable the gyro with the phone pointing at alpha 137
  and 22° back → heading stays **55.0°**, elevation becomes the real **−22.00°**
  from gravity. No swing.
* re-derives the offset as a pure world-up yaw, repairing any state left over
  from a stale or contaminated anchor (iOS's first readings are often garbage).
* drops the smoothing lag, so "does not move" is literal rather than approximate.

Pitch and roll need no re-levelling here because they are never corrected at all.
The button's copy changed from "tilted? hold straight" — now false — to
"keeps your heading".

`syncLookState()` also keeps the drag-look `yaw`/`pitch` in step with where the
gyro is pointing. Nothing reads them while the gyro drives, but they are what the
camera falls back to when it stops, so without this, turning motion **off** would
snap the view to wherever the last finger drag left it. That path is groundwork
for P55's GYRO toggle and is not reachable from today's UI.

## Verified

* Desktop untouched: no motion/recenter button, mouse-look still moves yaw and
  pitch (heading 0 → 33°, elevation −11.46 → −0.46). Touch-drag look unaffected.
* Console clean apart from the pre-existing Railway CORS errors on localhost.
* Not verifiable headlessly: real iOS/Android sensor behaviour (drift, the
  permission gesture), landscape rotation on a physical device, and the
  gyro-off handoff, which has no UI until P55.
