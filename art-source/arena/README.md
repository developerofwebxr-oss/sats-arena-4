# Arena GLB — uncompressed source. NOT SERVED.

`sats-arena-imperial-gold-v1-UNCOMPRESSED.glb` is the pack's original export:
7,479,076 bytes, 140,104 triangles, 20 primitives, 11 materials, three embedded
textures (308 KB total — the file is ~96% geometry).

The runtime copy in `src/assets/` is the SAME model Draco-compressed
(`gltf-transform draco`): 7.48 MB -> 891 KB, identical triangle count, primitive
count and bounds. Because of that, `arena-glb.js` now needs a DRACOLoader — the
decoder is already self-hosted in `public/draco/` and served at BASE_URL.

`sats-arena-gold-360-equirectangular-ORIGINAL.png` is the pack's original
panorama (2,980 KB). The runtime copy is the same 2048x1024 image re-encoded as
JPEG q82 (665 KB) — a skybox needs no alpha, and at PNG size the "lighter"
mobile fallback was 3.3x heavier than the Draco arena it replaces.
