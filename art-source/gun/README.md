# Gun model — source / backup

`sats-arena-better-gun-ORIGINAL-375k.glb` is the ORIGINAL, un-simplified gun as
delivered: 374,990 triangles, 1 mesh / 1 primitive / 1 material, Draco-compressed,
one 1024x1024 baseColor JPEG.

It is kept here as the archival source. **This folder is NOT served** — nothing
imports it, it is outside `public/`, and Vite only emits assets reachable from
the module graph. The runtime model is `src/assets/sats-arena-better-gun.glb`.

Why it was replaced: P31 measurement showed the gun alone was 374,990 triangles —
2.75x the entire 136k arena — and the dominant cost in a ~512k-triangle frame,
well over a comfortable Quest 72fps budget. See the P32 commit for the pipeline
(weld -> simplify -> single-sided) and the before/after numbers.
