# Satoshi face — source and what was done to it

`SA4_golden_box-ORIGINAL.png` is the asset as supplied: 1254x1254, **PNG
colortype 2 (RGB), no alpha channel and no tRNS**.

That matters. It *looks* like a cut-out because the supplied file has a
transparency CHECKERBOARD BAKED INTO ITS PIXELS. Put straight onto a plane it
would have rendered as a grey-and-white checked square with a face in the
middle.

The runtime copy in `src/assets/satoshi-face.png` is the same artwork with that
surround removed and downscaled:

  1. **Border flood fill**, not a global colour key. A global key on "near-white,
     near-neutral" would also have punched holes in the glasses lenses and the
     hair highlights, which are the same colours. Filling only from the image
     border removes surround pixels actually connected to the outside, and the
     face's dark outline stops the fill. 801,285 px cleared (51%).
  2. **Downscaled 1254 -> 512.** At 1254 the RGBA PNG was 1.5 MB, which would
     have undone a chunk of the P39 initial-load work for a texture that is
     drawn on a sub-metre plane. 512 is still ~2x the pixels it ever needs.

No artwork was drawn, painted or generated — this is the supplied image with a
baked background removed and a resample applied.
