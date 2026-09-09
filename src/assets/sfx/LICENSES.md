# SFX licensing

Every file here is **procedurally synthesized** by `scripts/sfx_synth.py` —
oscillators, envelopes and filters, computed with numpy on this Mac.

## No model, no licence, no attribution

There is **no third-party model, dataset or sample** in any of these files. They
are arithmetic, so they are original work belonging to this project. Nothing to
attribute, no token to obtain, no commercial-use question to answer.

That is not just convenient — it is the right tool. Cartoon SFX have always been
synthesis and Foley trickery rather than recordings of real events, so a
"boing", a jaw snap and a villain's "nyeh heh heh" are *more* faithful from
oscillators than from any model trained to sound real.

## What was considered and dropped

**Bark (`suno/bark-small`, MIT)** produced the first version of the vocal sounds.
It works and it is MIT, but it is a *speech* model: its whole purpose is to sound
like a real human, which is the opposite of the arcade-cartoon brief. Rejected on
character, not licence. The backend is still in `scripts/gen-sfx.py` if a
realistic voice is ever wanted.

**Stable Audio Open** — gated; needs a one-time HF licence acceptance and token.
Never used, and no longer needed: the Foley it was wanted for (jaw snap, door
creak) is synthesized here.

**AudioCraft / AudioGen** — ungated, but **CC-BY-NC-4.0: non-commercial**. This
game takes Lightning payments, so its output could not have shipped.

**Freesound / ElevenLabs** — not used. No key present for either, and neither is
needed now.
