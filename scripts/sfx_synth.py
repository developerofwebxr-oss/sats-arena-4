#!/usr/bin/env python3
"""
sfx_synth.py — procedural CARTOON sound effects. No model, no licence, no token.

Runs inside ComfyUI's venv (numpy + scipy only). Every sound here is arithmetic,
so the output is original work with nothing to attribute and nothing to accept.

── WHY SYNTHESIS AND NOT A MODEL ───────────────────────────────────────────
The first pass used Bark, which is a *speech* model — it is built to sound like a
real person, and it did. That is exactly wrong for an arcade game: the brief is
exaggerated, bouncy, synthy, cartoon. Classic cartoon SFX have always been
synthesis and Foley tricks, not recordings of real events, so the tool that fits
is a handful of oscillators and envelopes. It also unblocks the four Foley sounds
Bark could not make at all (a jaw snap, a door creak), with no HF token.

── THE CARTOON VOCABULARY, in DSP terms ────────────────────────────────────
  boing / bounce   a pitch that swoops and overshoots, not one that decays
  laugh            discrete syllables, not a continuous tone — the gap between
                   "heh"s is what makes it read as a laugh
  voice            a buzzy source through two resonant peaks (formants); that is
                   what turns a sawtooth into a vowel
  wet / organic    noise through a moving band-pass, plus a pitch that slides
  creak            heavy amplitude modulation — a creak is a fast stick-slip
                   rattle, which is why a smooth tone never sounds like one
  arcade           a little quantisation (bitcrush); cheap 8-bit grit
"""

import numpy as np

SR = 24000   # plenty for SFX, and keeps the files small


# ── Primitives ───────────────────────────────────────────────────────────────

def t_axis(dur): return np.arange(int(SR * dur)) / SR

def osc(freq, dur, wave="sine", phase=0.0):
    """Oscillator that accepts a per-sample frequency array, so sweeps are free."""
    t = t_axis(dur)
    f = np.full_like(t, freq, dtype=np.float64) if np.isscalar(freq) else np.asarray(freq, dtype=np.float64)[:len(t)]
    ph = 2 * np.pi * np.cumsum(f) / SR + phase
    if wave == "sine":     return np.sin(ph)
    if wave == "saw":      return 2 * ((ph / (2 * np.pi)) % 1.0) - 1
    if wave == "square":   return np.sign(np.sin(ph))
    if wave == "triangle": return 2 * np.abs(2 * ((ph / (2 * np.pi)) % 1.0) - 1) - 1
    raise ValueError(wave)

def sweep(a, b, dur, curve="exp"):
    """Frequency ramp. Exponential reads as musical; linear reads as mechanical."""
    n = int(SR * dur)
    x = np.linspace(0, 1, n)
    return a * (b / a) ** x if curve == "exp" else a + (b - a) * x

def env_ad(dur, attack=0.005, decay=None, power=2.0):
    """Percussive attack/decay. `power` shapes the tail — higher is snappier."""
    n = int(SR * dur); decay = decay if decay is not None else dur - attack
    a = int(SR * attack); d = max(1, n - a)
    return np.concatenate([np.linspace(0, 1, a), (np.linspace(1, 0, d)) ** power])[:n]

def noise(dur, seed=0):
    return np.random.default_rng(seed).uniform(-1, 1, int(SR * dur))

def biquad_bp(x, f0, q):
    """One resonant band-pass, applied by hand so scipy.signal is not needed."""
    f0 = max(20.0, min(f0, SR * 0.45))
    w0 = 2 * np.pi * f0 / SR; alpha = np.sin(w0) / (2 * q)
    b = np.array([alpha, 0.0, -alpha]); a = np.array([1 + alpha, -2 * np.cos(w0), 1 - alpha])
    b /= a[0]; a = a / a[0]
    y = np.zeros_like(x); x1 = x2 = y1 = y2 = 0.0
    for i, xi in enumerate(x):
        yi = b[0] * xi + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2
        y[i] = yi; x2, x1 = x1, xi; y2, y1 = y1, yi
    return y

def formants(x, f1, f2, q1=9.0, q2=11.0):
    """Two resonant peaks = a vowel. This is what makes a buzz sound like a voice."""
    return 0.75 * biquad_bp(x, f1, q1) + 0.55 * biquad_bp(x, f2, q2)

def bitcrush(x, bits=6):
    """
    Retro quantisation that survives a decay.

    Plain bitcrush quantises against FULL SCALE, so a sound that has decayed to
    10% of peak is only spanning ~13 of its levels and the tail stops being a
    tone and becomes fizz. Measured on the first attempt: the hit sting's
    spectral centroid ran 1833 -> 702 Hz as designed, and crushing pushed the
    final quarter back up to 3128 Hz. Gating the tail did not fix it either —
    the distortion is in the body of the decay, not just the silence.

    So the crush is applied to the ENVELOPE-NORMALISED signal and the envelope is
    put back afterwards. The grit is then proportional at every amplitude: the
    8-bit character stays, and a decaying tone stays a tone.
    """
    step = 2.0 ** (1 - bits)
    w = max(1, int(SR * 0.004))
    env = np.convolve(np.abs(x), np.ones(w) / w, mode="same")
    env = np.maximum(env, 1e-4)
    return np.round((x / env) / step) * step * env


def vibrato(freq, dur, rate, depth):
    return freq * (1 + depth * np.sin(2 * np.pi * rate * t_axis(dur)))

def cat(*parts):
    return np.concatenate([p for p in parts if len(p)])

def silence(dur): return np.zeros(int(SR * dur))

def norm(x, peak=0.89):
    m = float(np.abs(x).max()) or 1.0
    return x * (peak / m)


# ── The sounds ───────────────────────────────────────────────────────────────

def satoshi_laugh(rng):
    """
    Cartoon-villain "nyeh heh heh heh".

    The laugh reads from its RHYTHM, so each syllable is a separate burst with a
    real gap after it. Inside a syllable, a buzzy saw is pushed through two
    formants tuned to an /eh/ vowel; the pitch blips up and falls across the
    syllable, and the whole run descends, which is the classic villain contour.
    """
    base = rng.uniform(240, 280)          # pitched UP — cartoon, not a real man
    # SIX to EIGHT syllables. Four read as a stutter, not a laugh: the pattern
    # needs long enough to establish itself before the descent lands.
    n = rng.integers(6, 9)
    out = []
    for i in range(int(n)):
        d = rng.uniform(0.12, 0.17)
        f0 = base * (0.93 ** i)           # each "heh" lower than the last
        f = sweep(f0 * 1.22, f0 * 0.88, d)
        f = vibrato(f, d, rate=rng.uniform(16, 24), depth=0.05)
        src = 0.7 * osc(f, d, "saw") + 0.3 * osc(f * 2.01, d, "square")
        voiced = formants(src, f1=rng.uniform(520, 600), f2=rng.uniform(1750, 2050))
        out.append(voiced * env_ad(d, 0.008, power=1.6))
        out.append(silence(rng.uniform(0.045, 0.075)))
    return cat(*out)


def satoshi_hit(rng):
    """Comedic pop + boing: a bright transient, then a springy overshoot."""
    d1 = 0.05
    pop = noise(d1, int(rng.integers(0, 9999)))
    pop = biquad_bp(pop, rng.uniform(1600, 2200), 1.2) * env_ad(d1, 0.001, power=4)

    d2 = rng.uniform(0.30, 0.42)
    f = sweep(rng.uniform(760, 900), rng.uniform(150, 190), d2)
    # A boing is a spring: the pitch wobbles as it falls rather than sliding.
    f = f * (1 + 0.16 * np.sin(2 * np.pi * rng.uniform(11, 15) * t_axis(d2)) * np.linspace(1, 0, len(t_axis(d2))))
    boing = osc(f, d2, "triangle") * env_ad(d2, 0.004, power=1.8)
    return cat(pop * 0.8, boing)


def snapper_emerge(rng):
    """
    Silly monster growl-squelch.

    Two layers: a low buzzy growl with a heavy slow wobble (a cartoon monster is
    never a steady tone), and a wet band-passed noise layer sliding upward, which
    is what sells "something organic is coming out of a hole".
    """
    d = rng.uniform(1.4, 1.9)
    f = sweep(rng.uniform(70, 90), rng.uniform(150, 190), d)
    f = vibrato(f, d, rate=rng.uniform(7, 11), depth=0.22)
    growl = 0.6 * osc(f, d, "saw") + 0.4 * osc(f * 1.5, d, "square")
    growl = formants(growl, f1=rng.uniform(380, 460), f2=rng.uniform(900, 1150))
    growl *= osc(rng.uniform(18, 26), d, "sine") * 0.35 + 0.65     # ring-ish chatter

    wet = noise(d, int(rng.integers(0, 9999)))
    wet = biquad_bp(wet, rng.uniform(900, 1300), 2.2) * np.linspace(0.15, 1.0, int(SR * d)) ** 2
    return (growl * 0.75 + wet * 0.5) * env_ad(d, 0.06, power=1.1)


def snapper_snap(rng):
    """Jaw snap: two hard clicks a hair apart — one click reads as a tap."""
    def click(f0, d=0.028, seed=0):
        c = noise(d, seed)
        c = biquad_bp(c, f0, 3.0) * env_ad(d, 0.0008, power=6)
        thump = osc(sweep(f0 * 0.5, f0 * 0.18, d), d, "sine") * env_ad(d, 0.001, power=5)
        return c * 0.8 + thump * 0.6
    a = click(rng.uniform(2200, 2900), seed=int(rng.integers(0, 9999)))
    b = click(rng.uniform(1500, 2000), seed=int(rng.integers(0, 9999)))
    return cat(a, silence(rng.uniform(0.020, 0.035)), b * 0.85)


def snapper_hit(rng):
    """Squelchy retreat: a wet splat, then a deflating slide-whistle down."""
    d1 = rng.uniform(0.10, 0.15)
    splat = noise(d1, int(rng.integers(0, 9999)))
    splat = biquad_bp(splat, rng.uniform(600, 900), 1.4) * env_ad(d1, 0.002, power=3)

    d2 = rng.uniform(0.35, 0.50)
    f = sweep(rng.uniform(900, 1100), rng.uniform(120, 170), d2, "exp")
    whistle = osc(f, d2, "sine") * env_ad(d2, 0.01, power=1.4)
    wob = osc(f * 0.5, d2, "triangle") * env_ad(d2, 0.01, power=2) * 0.35
    return cat(splat, (whistle + wob) * 0.9)


def door_open(rng):
    """
    Cartoon creak.

    A creak is stick-slip: the surface grabs and releases many times a second. So
    the character comes from AMPLITUDE MODULATION at an audible rate, not from
    the pitch. Modulate a smooth tone and it will never sound like a door.
    """
    d = rng.uniform(0.65, 0.90)
    f = sweep(rng.uniform(180, 230), rng.uniform(320, 420), d)
    src = osc(f, d, "saw")
    src = formants(src, f1=rng.uniform(700, 900), f2=rng.uniform(1900, 2400), q1=12, q2=14)
    ratchet = (osc(rng.uniform(26, 38), d, "square") * 0.5 + 0.5) ** 1.5
    return src * ratchet * env_ad(d, 0.03, power=1.2)


def door_close(rng):
    """Thud + latch clunk: the low body, then a small bright click."""
    d1 = rng.uniform(0.16, 0.22)
    thud = osc(sweep(rng.uniform(170, 210), rng.uniform(55, 70), d1), d1, "sine")
    thud = thud * env_ad(d1, 0.002, power=3)
    d2 = 0.035
    clunk = noise(d2, int(rng.integers(0, 9999)))
    clunk = biquad_bp(clunk, rng.uniform(1200, 1700), 2.5) * env_ad(d2, 0.001, power=5)
    return cat(thud, clunk * 0.55)


RECIPES = {
    "satoshi-laugh":  satoshi_laugh,
    "satoshi-hit":    satoshi_hit,
    "snapper-emerge": snapper_emerge,
    "snapper-snap":   snapper_snap,
    "snapper-hit":    snapper_hit,
    "door-open":      door_open,
    "door-close":     door_close,
}

# A light bitcrush on the short arcade-y stings only. On the laugh or the growl
# it just sounds broken; on a blip it reads as retro.
CRUSH = {"satoshi-hit": 7, "snapper-snap": 7, "door-close": 7}


def render(name, seed):
    rng = np.random.default_rng(seed)
    x = RECIPES[name](rng)
    if name in CRUSH: x = bitcrush(x, CRUSH[name])
    return norm(np.nan_to_num(x)), SR


if __name__ == "__main__":
    import json, sys
    from scipy.io import wavfile
    cfg = json.load(sys.stdin)
    files = []
    for i, seed in enumerate(cfg["seeds"]):
        a, sr = render(cfg["name"], seed)
        p = f'{cfg["tmp"]}/{cfg["name"]}.v{i+1}.raw.wav'
        wavfile.write(p, sr, (np.clip(a, -1, 1) * 32767).astype(np.int16))
        files.append(p)
    print(json.dumps({"sr": SR, "files": files}))
