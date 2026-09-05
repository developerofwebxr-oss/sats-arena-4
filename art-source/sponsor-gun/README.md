# Sponsor gun (LNbits) — source / backup. NOT SERVED.

Nothing imports this folder; it sits outside `public/` and is not in the module
graph, so Vite never emits it. The runtime assets are in `src/assets/`.

| file | what |
|---|---|
| `NEW_gun_SA4-ORIGINAL-372k.glb` | original export, 372,674 tris, doubleSided |
| `NEW_gun_logos_facing_right.png` | 1536x1024 logo sheet, LNbits on the LEFT |
| `NEW_gun_logos_facing_left.png`  | 1536x1024 logo sheet, LNbits on the RIGHT |

## Runtime derivation

* `src/assets/sponsor-gun.glb` — weld -> meshoptimizer simplify (ratio 0.12,
  error 0.0015) -> single-sided -> Draco. 372,674 -> 44,720 tris, 1.6 MB -> 519 KB.
  Bounds unchanged, so the orientation contract still holds.
* `src/assets/sponsor-logo-{right,left}.png` — the LNbits lockup cropped out of
  each sheet (right: px 234,421 535x163 / left: px 821,410 576x177), scaled to
  512 wide. Alpha background preserved.

## The logo sheets are NOT mirror-pairs

Worth recording because it is counter-intuitive: the two sheets contain the SAME
two logos with their POSITIONS swapped, and the LNbits wordmark reads FORWARD in
both. Neither is pre-flipped. Applying either to a mirrored mesh would render the
sponsor's wordmark BACKWARDS. That is why the runtime decal is parented to the
gun GROUP rather than to the mirrored model — see weapon.js.
