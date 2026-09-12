# P53 — the Carnivorous "stitch" lines

## What the object turned out to be

Not the arena boundary wireframe, not the radar floor, not a debug outline.
The lines are **inside the Carnivorous GLB**. Picked by raycast at the two
reported screen positions, then confirmed by hiding each of the scene's 106
visible meshes one at a time and diffing the framebuffer:

| symptom | mesh | group | material |
|---|---|---|---|
| vertical lines mid-wall, both sides | `Veins` (2,592 tris, y 2.00–6.57 m) | `SatsArena_Carnivorous_v2 / Environment_Carnivorous` | `Sap` |
| curved line at floor level | `FloorRoots_2` (1,608 tris, y 0.000–0.020 m) | `… / Environment_Carnivorous / FloorRoots` | `Sap` |
| (same material, overhead) | `HangingGrowth_2` (3,216 tris) | `… / Environment_Carnivorous / HangingGrowth` | `Sap` |

`Sap` is `MeshStandardMaterial`, colour `#cb8e1d`, **emissive `#e19516` at 1.95** —
self-lit amber in a room that is otherwise near-black.

## The confirmed cause: z-fighting, not a stray helper

Every `Sap` mesh is a thin ribbon modelled **flush with the surface it decorates**:

* `FloorRoots_2` occupies y 0.000–0.020 against a `Floor` at y = 0.
* A ray through a vein returns the vein and the `Bark` behind it at the **same
  distance** (11.88 m, measured at 1024×768 from the 1.6 m eye).

At arena range the depth buffer cannot separate them, so the ribbon renders in
fragments. **Measured:** with `polygonOffset(-8, -8)` pulling `Sap` toward the
camera, **2.5× more of it draws** (1,452 → 3,602 px) — that ratio is the
z-fighting. Each surviving fragment is a saturated emissive hairline against a
dark room, which is why it reads as a broken yellow stitch rather than a vein.

Ruled out by inspection:

* `arena.js` boundary wireframe — Carnivorous (and Gold) **never call
  `buildArena`**; its only caller is Classic, which already hides the edges (P50).
* base radar floor — Carnivorous already declared `hidesBaseFloor` (P31 pattern).
* debug outlines — the scene contains exactly three `Line` objects: the camera
  laser and the two XR controller rays.

## The fix

Per-skin declaration, one writer:

* `registry.js` — `hidesBaseFloor: true` became a `hides` block. Carnivorous
  declares `hides: { baseFloor: true, materials: ['Sap'] }`; Gold declares
  `hides: { baseFloor: true }`; Classic declares nothing.
* `skin-manager.js` — `applyHides()` is the only code that writes `.visible` for
  a skin, and every object it turns off is recorded and turned back on in
  `teardown()`. An async environment re-runs it via `ctx.applyHides()` once its
  GLB has actually landed.

A polygon offset was rejected: it makes the hairlines **solid and brighter**,
i.e. more of the artefact. Logical bounds are untouched — coin spawn is
`SPAWN_MODES` in `targets.js` and reads none of this.

## Verified

* 36 views (12 yaws × 3 pitches): **43,338** stitch pixels removed, present in
  **all 36** before, **0** after.
* Leak assertion `ok: true, strays: 0` across
  carnivorous → classic → gold → carnivorous → classic, including the cold path
  (switch before the GLB finishes loading) and warm re-entry.
* Coin spawn unchanged: r 2.7–7.0, h 0.8–2.9 against `SPAWN_MODES.vr` (r 3–7, h 1–3).
* Classic and Gold pixel-unchanged — see `after-classic-unchanged.png`,
  `after-gold-unchanged.png`.

Pairs below are matched (same frame, same lighting, only `Sap` toggled):
`before/after-wall.png`, `before/after-floor.png`, `before/after-level.png`.
