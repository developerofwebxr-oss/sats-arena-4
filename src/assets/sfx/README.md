# src/assets/sfx

Cartoon game SFX, **procedurally synthesized** on this machine. No model, no
licence, no attribution — see `LICENSES.md`.

| file | length | size | for |
|---|---|---|---|
| `satoshi-laugh.m4a`  | 1.56 s | 12 KB | Satoshi pops out of a door (P42b `sounds.emerge`) |
| `satoshi-hit.m4a`    | 0.38 s |  7 KB | Satoshi shot (P42b `sounds.hit`) |
| `snapper-emerge.m4a` | 1.63 s | 13 KB | Carnivorous Snapper lunge (P47) |
| `snapper-snap.m4a`   | 0.08 s |  5 KB | Snapper idle jaw snap |
| `snapper-hit.m4a`    | 0.49 s |  7 KB | Snapper shot |
| `door-open.m4a`      | 0.77 s | 11 KB | Gold Arena door creak |
| `door-close.m4a`     | 0.21 s |  5 KB | Gold Arena door thud |

**84 KB for the whole set**, each lazy-loadable.

## The cartoon vocabulary, in DSP

What makes these read as arcade rather than real:

| effect | how |
|---|---|
| boing / bounce | pitch that swoops and *overshoots*, not one that decays |
| laugh | discrete syllables with real gaps — the gap is what makes it a laugh |
| voice | buzzy saw through two resonant peaks (formants) = a vowel |
| wet / organic | noise through a moving band-pass plus a sliding pitch |
| creak | heavy amplitude modulation — a creak is stick-slip rattle, so a smooth tone never sounds like one |
| arcade | light bitcrush, applied **envelope-relative** so a decaying tone stays a tone instead of turning to fizz |

## Regenerating

    python3 scripts/gen-sfx.py                    # all seven
    python3 scripts/gen-sfx.py satoshi-laugh      # one
    python3 scripts/gen-sfx.py satoshi-laugh --variants 8 --keep-variants

Each run makes N variants, trims silence, peak-normalises to 0.89 (headroom so
layered SFX don't clip the master), fades the ends, scores against the sound's
target duration, and keeps the best. Tune a sound by editing its recipe in
`scripts/sfx_synth.py`; add one with a new function plus a `RECIPES` entry.

## Why `.m4a`

No ffmpeg or sox on this machine, and macOS `afconvert` encodes neither MP3 nor
Vorbis. AAC in `.m4a` is the same trade — small and compressed — and decodes in
WebAudio on every browser this game targets.

## Wiring

**Not wired into gameplay here.** P42b and P47 consume these through swappable
`sounds.emerge` / `sounds.hit` slots that take a *function*, so the consumer owns
loading and playback.
