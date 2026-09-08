# src/assets/sfx

Game sound effects, generated locally. See `LICENSES.md` for terms.

## Present

| file | length | size | for |
|---|---|---|---|
| `satoshi-laugh.m4a`  | 2.82 s | 20 KB | Gold Arena — Satoshi pops out of a door (P42b `sounds.emerge`) |
| `satoshi-hit.m4a`    | 0.58 s |  7 KB | Satoshi shot (P42b `sounds.hit`) |
| `snapper-emerge.m4a` | 2.22 s | 16 KB | Carnivorous Snapper lunge (P47 `sounds.emerge`) |

Total **43 KB** — small enough for mobile, and each is lazy-loadable.

## Still owed

`snapper-snap`, `snapper-hit`, `door-open`, `door-close`. These are Foley, and
Bark is a *speech* model — it does human non-verbal sound well and a door creak
not at all. They need Stable Audio Open, which is gated behind a one-time licence
acceptance (see `LICENSES.md`), or a free Freesound key. The script already has
both backends wired and prints the exact unblocking steps.

## Why `.m4a` and not `.ogg` / `.mp3`

There is no `ffmpeg` and no `sox` on this machine, and macOS's built-in
`afconvert` can decode MP3 but cannot encode MP3 or Vorbis. Installing ffmpeg via
brew would be a large system-wide change to the owner's machine. AAC in an `.m4a`
is the same trade — compressed and small — and every browser this game targets
(Safari, Chrome, Firefox, Quest Browser) decodes it in WebAudio.

## Regenerating

    python3 scripts/gen-sfx.py                       # everything
    python3 scripts/gen-sfx.py satoshi-laugh         # one sound
    python3 scripts/gen-sfx.py satoshi-laugh --variants 5 --keep-variants
    python3 scripts/gen-sfx.py my-new-sfx --prompt "[laughs] ho ho" --voice v2/en_speaker_3

Each run makes N variants, trims silence, peak-normalises to 0.89, fades the
ends, scores them against the sound's target duration and keeps the best. Add a
new sound by adding one entry to `SOUNDS` in the script.

## Wiring

**Not wired into gameplay here, by design.** P42b and P47 consume these through
their swappable `sounds.emerge` / `sounds.hit` slots, which take a *function*, so
the consumer decides how to load and play.
