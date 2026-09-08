# SFX licensing

Every file here was generated **locally on this Mac**. Nothing was uploaded: the
only network traffic was the one-time model download from Hugging Face.

## Generator used: Bark (`suno/bark-small`)

- **Model licence: MIT** — https://huggingface.co/suno/bark-small
- MIT permits commercial use, so output is safe to ship in a game that takes
  Lightning payments.
- Suno's model card asks that generated audio not be used to impersonate a real
  person or to mislead. These are non-verbal cartoon vocalisations (a laugh, an
  "oof", a growl) attached to an illustrated character, not an imitation of any
  identifiable individual.

| file | prompt | voice preset |
|---|---|---|
| `satoshi-laugh.m4a`  | `[laughs] hehehe [laughs]`      | `v2/en_speaker_6` (male) |
| `satoshi-hit.m4a`    | `[gasps] oof!`                  | `v2/en_speaker_6` (male) |
| `snapper-emerge.m4a` | `[growls] grrraaahh [hisses]`   | `v2/en_speaker_9` |

## Backends considered and NOT used

**Stable Audio Open — blocked, needs one manual step.** The HF repo is
`gated: auto` and its weights return HTTP 401 without a token. It is the right
tool for the missing Foley (door creak, jaw snap, squelch). To unblock, once:
accept the Stability AI Community Licence at
https://huggingface.co/stabilityai/stable-audio-open-1.0, create a read token,
and `export HF_TOKEN=…`. Note the Community Licence is free for commercial use
only **below** an annual-revenue threshold; above it Stability requires an
enterprise licence. Worth reading before shipping its output commercially.

**AudioCraft / AudioGen — ruled out on LICENCE, not capability.**
`facebook/audiogen-medium` is ungated and would have run, but its weights are
**CC-BY-NC-4.0: non-commercial**. This game takes payments, so its output cannot
ship here. Free is not the same as usable.

**Freesound — not used, needs a free API key** (none on this machine). If it is
ever used, CC0 clips need no attribution but **CC-BY clips must be credited**,
and the credit belongs in this file.

**ElevenLabs — not used.** No API key is present on this machine, and the brief
ruled out requiring one.
