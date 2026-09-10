/**
 * audio.js — synthesized sound effects via Web Audio API.
 *
 * No external files. Everything is generated in code.
 *
 * Rules:
 *   - AudioContext is created lazily on the first play call (browsers block
 *     it before a user gesture — this pattern satisfies that requirement).
 *   - One shared context is reused for all sounds (creating a new one per
 *     sound would hit browser limits and add latency).
 *   - All nodes are created fresh per sound call, connected to ctx.destination,
 *     and automatically garbage-collected after they finish.
 */

// Shared AudioContext — null until the first user gesture triggers a play call.
let ctx = null;

/**
 * getCtx() — returns the shared AudioContext, creating it on first call.
 * Safe to call inside any play function because they are always triggered
 * by user input (click, tap, or controller trigger).
 */
function getCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  // Some browsers suspend the context even after creation if there was no
  // prior gesture — resume it just in case.
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * makeEnvelope(ctx, peakGain, attackTime, decayTime, startTime)
 * Returns a GainNode with a quick attack and exponential decay.
 * All sounds use this shape — instant(ish) attack, then fade to silence.
 */
function makeEnvelope(ctx, peakGain, attackTime, decayTime, startTime) {
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, startTime);                            // start silent (can't ramp from 0)
  env.gain.linearRampToValueAtTime(peakGain, startTime + attackTime);    // attack
  env.gain.exponentialRampToValueAtTime(0.0001, startTime + attackTime + decayTime); // decay to silence
  return env;
}

/**
 * playTone(freq, type, peakGain, attackTime, decayTime, startTime, freqEndValue, freqSweepTime)
 * Creates an oscillator → envelope → destination chain.
 * Optional freq sweep: if freqEndValue is provided, pitch bends exponentially to it.
 */
function playTone(ctx, freq, type, peakGain, attackTime, decayTime, startTime, freqEndValue, freqSweepTime) {
  const osc = ctx.createOscillator();
  const env = makeEnvelope(ctx, peakGain, attackTime, decayTime, startTime);

  osc.type = type;
  osc.frequency.setValueAtTime(freq, startTime);

  if (freqEndValue && freqSweepTime) {
    // Exponential pitch sweep — gives the "zap" or "chime" character.
    osc.frequency.exponentialRampToValueAtTime(freqEndValue, startTime + freqSweepTime);
  }

  osc.connect(env);
  env.connect(ctx.destination);

  osc.start(startTime);
  osc.stop(startTime + attackTime + decayTime + 0.01); // tiny buffer so the node cleans up
}

/**
 * playNoise(peakGain, attackTime, decayTime, startTime, filterFreq)
 * Creates a white noise burst through a bandpass filter → envelope → destination.
 * Used for the fizzy transient crack in the hit sound.
 */
function playNoise(ctx, peakGain, attackTime, decayTime, startTime, filterFreq) {
  // Web Audio has no built-in noise source — we fill a buffer with random samples.
  const bufferSize = ctx.sampleRate * (attackTime + decayTime + 0.02);
  const buffer     = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data       = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1; // white noise: uniform random in [-1, 1]
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  // Bandpass filter shapes the noise into a specific frequency region.
  const filter = ctx.createBiquadFilter();
  filter.type            = 'bandpass';
  filter.frequency.value = filterFreq;
  filter.Q.value         = 1.5; // bandwidth — higher Q = narrower, more tonal

  const env = makeEnvelope(ctx, peakGain, attackTime, decayTime, startTime);

  source.connect(filter);
  filter.connect(env);
  env.connect(ctx.destination);

  source.start(startTime);
  source.stop(startTime + attackTime + decayTime + 0.02);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * playHitSound() — sharp laser zap with a fizzy crack transient.
 *
 * Layer 1: sawtooth oscillator sweeping 880 Hz → 110 Hz over 0.12s.
 *   The downward pitch sweep is the classic "laser hit" character.
 * Layer 2: white noise burst through a bandpass at 2200 Hz.
 *   Adds the initial crack/pop that makes the hit feel solid.
 */
export function playHitSound() {
  const c   = getCtx();
  const now = c.currentTime;

  // Sawtooth sweep — harsh and cutting, drops in pitch like a deflating energy field.
  playTone(c,
    880,          // start frequency (Hz)
    'sawtooth',   // wave type
    0.35,         // peak gain
    0.005,        // attack (s) — nearly instant
    0.15,         // decay (s)
    now,
    110,          // sweep end frequency (Hz)
    0.12,         // sweep duration (s)
  );

  // Noise burst — fizzy transient that sits on top of the oscillator attack.
  playNoise(c,
    0.25,   // peak gain
    0.003,  // attack (s)
    0.08,   // decay (s) — very short, just the crack
    now,
    2200,   // bandpass centre frequency (Hz)
  );
}

/**
 * playMissSound() — a quiet, round, low thud. Not annoying on rapid misses.
 *
 * Single sine oscillator at 180 Hz, low gain, fast decay.
 * Sine = smooth and non-intrusive. No sweep, no noise — just a soft bump.
 */
export function playMissSound() {
  const c   = getCtx();
  const now = c.currentTime;

  playTone(c,
    180,     // frequency (Hz) — low and round
    'sine',  // wave type — smoothest, least harsh
    0.3,     // peak gain
    0.004,   // attack (s)
    0.14,    // decay (s)
    now,
    // No freq sweep — flat pitch feels "dull" which is exactly right for a miss
  );
}

/**
 * playReloadSound() — ascending Lightning chime, three notes.
 *
 * Three sine tones staggered 100ms apart: 440 → 660 → 880 Hz.
 * Each note has a shimmer layer one octave up at half gain.
 * The ascending pitch + stagger = "payment confirmed" / "power restored" feel.
 */
export function playReloadSound() {
  const c   = getCtx();
  const now = c.currentTime;

  // Note timings — staggered to create the arpeggio feel.
  const notes = [
    { freq: 440, startOffset: 0.0,  duration: 0.22 },
    { freq: 660, startOffset: 0.1,  duration: 0.22 },
    { freq: 880, startOffset: 0.2,  duration: 0.35 }, // landing note — longest
  ];

  notes.forEach(({ freq, startOffset, duration }) => {
    const t = now + startOffset;

    // Primary tone — sine for a clean bell-like character.
    playTone(c,
      freq,
      'sine',
      0.28,    // peak gain
      0.01,    // attack (s) — slight softening so it doesn't click
      duration,
      t,
    );

    // Shimmer layer — one octave up, half gain, triangle wave (softer harmonics).
    // This adds brightness without making the sound harsh.
    playTone(c,
      freq * 2,
      'triangle',
      0.12,    // peak gain — subtle shimmer
      0.01,
      duration * 0.8, // shimmer decays slightly faster than the fundamental
      t,
    );
  });
}

/**
 * playSatoshiHitSound() — a bright, rewarding sparkle for hitting a Satoshi target.
 *
 * A fast ascending four-note arpeggio (higher and snappier than the reload chime)
 * with an octave-up shimmer, so a big hit feels like a jackpot.
 */
export function playSatoshiHitSound() {
  const c   = getCtx();
  const now = c.currentTime;

  const notes = [
    { freq: 660,  startOffset: 0.0,  duration: 0.14 },
    { freq: 880,  startOffset: 0.05, duration: 0.14 },
    { freq: 1320, startOffset: 0.1,  duration: 0.16 },
    { freq: 1760, startOffset: 0.15, duration: 0.28 }, // bright landing note
  ];

  notes.forEach(({ freq, startOffset, duration }) => {
    const t = now + startOffset;
    playTone(c, freq, 'triangle', 0.26, 0.005, duration, t);   // clean bell
    playTone(c, freq * 2, 'sine', 0.10, 0.005, duration * 0.7, t); // shimmer
  });
}

/**
 * playDoorTargetEmergePlaceholder() — STAND-IN for the Satoshi laugh.
 *
 * ── THE REAL LAUGH IS OWED FROM P45 ─────────────────────────────────────────
 * P45 has NOT been run in this repo: there is no src/assets/sfx/ directory and
 * no satoshi-laugh file. Rather than invent or generate a laugh, this plays a
 * deliberately synthetic three-note taunt so the beat is audible and the
 * emerge/hold/retract timing can actually be felt while testing. It is not
 * pretending to be the laugh and should not ship as one.
 *
 * ── Swapping it is one line ─────────────────────────────────────────────────
 * The door-target config takes a FUNCTION in `sounds.emerge`, not a URL, so P45
 * can drop in whatever it produces — a decoded sample, a different synth, a
 * positional source — without this module or door-targets.js changing shape:
 *
 *     sounds: { emerge: playSatoshiLaugh, hit: playSatoshiHitSound }
 *
 * It routes through the SAME shared AudioContext as every other sound here, so
 * it inherits the existing lazy-create-on-gesture behaviour that satisfies iOS
 * and Chrome autoplay policy. There is no second audio path.
 */
export function playDoorTargetEmergePlaceholder() {
  const c   = getCtx();
  const now = c.currentTime;

  // Descending and slightly detuned — reads as "something just appeared and it
  // is not on your side", without impersonating a laugh.
  const notes = [
    { freq: 392, startOffset: 0.00, duration: 0.16 },
    { freq: 330, startOffset: 0.11, duration: 0.16 },
    { freq: 262, startOffset: 0.22, duration: 0.30 },
  ];
  notes.forEach(({ freq, startOffset, duration }) => {
    const t = now + startOffset;
    playTone(c, freq,        'sawtooth', 0.13, 0.01, duration, t);
    playTone(c, freq * 1.01, 'sawtooth', 0.10, 0.01, duration, t); // detune beat
  });
}

// ── Sample playback ──────────────────────────────────────────────────────────
// Everything above is synthesized. These two functions are the ONLY file path,
// and they deliberately go through the SAME getCtx() as the synth sounds so
// there is one AudioContext and one lazy-create-on-gesture story. A second
// context (or an <audio> element) would need its own iOS unlock and would be a
// second thing to get wrong.

const _sampleBytes  = new Map();   // url -> Promise<ArrayBuffer>
const _sampleBuffers = new Map();  // url -> AudioBuffer

/**
 * Fetch a sample's bytes WITHOUT touching the AudioContext.
 *
 * Split from decoding on purpose: fetching needs no user gesture, decoding does
 * (it needs the context). So a caller can warm the network early and still have
 * the first actual play be instant.
 */
export function preloadSample(url) {
  if (!_sampleBytes.has(url)) {
    _sampleBytes.set(url, fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return r.arrayBuffer();
    }));
  }
  return _sampleBytes.get(url);
}

/**
 * Play a sample. Safe to call before it has loaded — the first call decodes and
 * plays when ready, later calls are instant. A failure is warned and swallowed:
 * a missing sound effect must never take gameplay down with it.
 * @param {string} url
 * @param {{gain?: number, rate?: number}} [opts]
 */
export function playSample(url, { gain = 0.9, rate = 1 } = {}) {
  const c = getCtx();
  const start = (buf) => {
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(g).connect(c.destination);
    src.start();
  };

  const cached = _sampleBuffers.get(url);
  if (cached) { start(cached); return; }

  preloadSample(url)
    // decodeAudioData wants its own copy — it detaches the ArrayBuffer it is
    // given, which would break every later play from the same cached bytes.
    .then((bytes) => c.decodeAudioData(bytes.slice(0)))
    .then((buf) => { _sampleBuffers.set(url, buf); start(buf); })
    .catch((e) => console.warn(`[audio] sample failed: ${url}`, e));
}
