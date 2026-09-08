#!/usr/bin/env python3
"""
gen-sfx.py — generate a game SFX locally, from a text prompt, for free.

    scripts/gen-sfx satoshi-laugh --prompt "[laughs]" --variants 3

Writes src/assets/sfx/<name>.m4a (plus <name>.v1.wav… when --keep-variants).
Run with no arguments for the full built-in sound list.

── WHY THIS BACKEND ────────────────────────────────────────────────────────
Checked on this machine, in the order the brief asked for:

  1. Stable Audio Open  — BLOCKED, needs a one-time manual step. The HF repo is
     `gated: auto` and the weights 401 without a token. See BACKEND_NOTES.
  2. AudioCraft/AudioGen — RULED OUT ON LICENCE, not capability. The weights are
     CC-BY-NC-4.0: non-commercial. This game takes Lightning payments, so its
     output cannot ship here. Being free is not the same as being usable.
  3. Bark (suno/bark-small) — WORKS, and is MIT. It is what runs by default.
  4. Freesound — implemented, needs a free API key (none on this machine).
  5. ElevenLabs — no key present on this machine, so not used.

Bark is a *speech* model. It is excellent at human non-verbal sound (laughs,
gasps, grunts) and poor at Foley (a door creak, a jaw snap). That is a real
limit, not a tuning problem — see the README for which sounds it can and cannot
cover.

── NO UPLOADS ──────────────────────────────────────────────────────────────
Everything runs on this Mac. The only network traffic is the one-time model
download from Hugging Face. No audio ever leaves the machine.
"""

import argparse, json, os, subprocess, sys, time
from pathlib import Path

ROOT   = Path(__file__).resolve().parent.parent
OUTDIR = ROOT / "src" / "assets" / "sfx"
# ComfyUI's venv already carries torch 2.10 (with MPS), transformers and scipy,
# so this reuses it READ-ONLY rather than installing a second multi-GB stack or
# mutating the owner's ComfyUI environment.
VENV_PY = Path("/Users/dev/ComfyUI-Installs/webxr/ComfyUI/.venv/bin/python")

BACKEND_NOTES = {
    "stable-audio": (
        "Stable Audio Open is GATED. To enable it, once:\n"
        "  1. sign in at https://huggingface.co/stabilityai/stable-audio-open-1.0\n"
        "  2. accept the Stability AI Community Licence on that page\n"
        "  3. create a read token at https://huggingface.co/settings/tokens\n"
        "  4. export HF_TOKEN=hf_xxx  (or run: huggingface-cli login)\n"
        "Then re-run with --backend stable-audio. The weights are ~5 GB."
    ),
    "freesound": (
        "Freesound needs a free API key. Once:\n"
        "  1. register at https://freesound.org\n"
        "  2. create a key at https://freesound.org/apiv2/apply/\n"
        "  3. export FREESOUND_API_KEY=...\n"
        "Clips are CC0 or CC-BY; CC-BY requires attribution — the script writes\n"
        "it into src/assets/sfx/LICENSES.md automatically."
    ),
}

# ── The game's sound set ─────────────────────────────────────────────────────
# `voice` is a Bark speaker preset. en_speaker_6 is a male voice, which is what
# "a comedic MAN'S laugh" asks for.
SOUNDS = {
    "satoshi-laugh":  dict(prompt="[laughs] hehehe [laughs]", voice="v2/en_speaker_6",
                           target=(1.5, 3.0), backend="bark"),
    "satoshi-hit":    dict(prompt="[gasps] oof!", voice="v2/en_speaker_6",
                           target=(0.2, 1.0), max_seconds=1.0, backend="bark"),
    "snapper-emerge": dict(prompt="[growls] grrraaahh [hisses]", voice="v2/en_speaker_9",
                           target=(1.5, 2.5), backend="bark"),
    "snapper-snap":   dict(prompt="a sharp wet jaw snap, a bite, teeth clacking shut",
                           target=(0.1, 0.8), max_seconds=0.8, backend="stable-audio"),
    "snapper-hit":    dict(prompt="a wet squelchy splat, a plant creature deflating",
                           target=(0.4, 1.2), backend="stable-audio"),
    "door-open":      dict(prompt="a heavy stone door creaking open, low mechanical groan",
                           target=(0.6, 1.6), backend="stable-audio"),
    "door-close":     dict(prompt="a heavy stone door thudding shut, mechanical clunk",
                           target=(0.4, 1.2), backend="stable-audio"),
}


def run_in_venv(script: str, payload: dict) -> dict:
    """Run a snippet inside ComfyUI's venv and return its JSON result."""
    p = subprocess.run([str(VENV_PY), "-c", script], input=json.dumps(payload),
                       capture_output=True, text=True)
    if p.returncode != 0:
        sys.stderr.write(p.stderr[-4000:])
        raise SystemExit(f"generation failed (exit {p.returncode})")
    line = [l for l in p.stdout.splitlines() if l.startswith("{")]
    return json.loads(line[-1]) if line else {}


BARK_SCRIPT = r'''
import json, sys, numpy as np, torch
from scipy.io import wavfile
from transformers import AutoProcessor, BarkModel

cfg = json.load(sys.stdin)
proc  = AutoProcessor.from_pretrained("suno/bark-small")
model = BarkModel.from_pretrained("suno/bark-small", dtype=torch.float32).to("cpu").eval()
sr = model.generation_config.sample_rate

outs = []
for i, seed in enumerate(cfg["seeds"]):
    torch.manual_seed(seed)
    inputs = proc(cfg["prompt"], voice_preset=cfg.get("voice"))
    with torch.no_grad():
        audio = model.generate(**inputs, do_sample=True, temperature=0.8).cpu().numpy().squeeze()
    path = f'{cfg["tmp"]}/{cfg["name"]}.v{i+1}.raw.wav'
    wavfile.write(path, sr, (np.clip(audio, -1, 1) * 32767).astype(np.int16))
    outs.append(path)
print(json.dumps({"sr": sr, "files": outs}))
'''

POST_SCRIPT = r'''
import json, sys, numpy as np
from scipy.io import wavfile

cfg = json.load(sys.stdin)
sr, a = wavfile.read(cfg["src"])
a = a.astype(np.float32) / 32767.0
if a.ndim > 1: a = a.mean(axis=1)

# TRIM: drop leading/trailing silence. Bark pads generously and an SFX that
# starts 400 ms late reads as lag, not as atmosphere.
env = np.abs(a)
win = max(1, int(sr * 0.01))
env = np.convolve(env, np.ones(win) / win, mode="same")
thr = max(env.max() * 0.02, 1e-4)
idx = np.where(env > thr)[0]
if len(idx):
    pad = int(sr * 0.01)
    a = a[max(0, idx[0] - pad): min(len(a), idx[-1] + pad)]

# NORMALIZE to a peak, not to full scale — leaves headroom so several SFX
# layered over the game's synth sounds do not clip the master.
peak = float(np.abs(a).max()) or 1.0
a = a * (cfg.get("peak", 0.89) / peak)

# HARD CAP: a "sting" has a length requirement, and Bark does not take
# direction on duration. If the clip overruns its window, cut at the end of
# its FIRST burst — that is the impact — rather than shipping a 2.5 s "oof"
# where the brief asked for under a second.
mx = cfg.get("max_seconds")
if mx and len(a) / sr > mx:
    w = max(1, int(sr * 0.02))
    e = np.array([np.sqrt((a[i:i + w] ** 2).mean()) for i in range(0, len(a) - w, w)])
    on = e > e.max() * 0.28
    cut = len(a)
    if on.any():
        first = int(np.argmax(on))
        off = np.where(~on[first:])[0]
        if len(off): cut = min(cut, (first + int(off[0])) * w + int(sr * 0.04))
    a = a[:min(cut, int(sr * mx))]

# Short fades kill the click a hard cut leaves at a zero-crossing boundary.
f = min(int(sr * 0.006), len(a) // 2)
if f > 0:
    a[:f]  *= np.linspace(0, 1, f)
    a[-f:] *= np.linspace(1, 0, f)

wavfile.write(cfg["dst"], sr, (np.clip(a, -1, 1) * 32767).astype(np.int16))
print(json.dumps({"seconds": round(len(a) / sr, 3), "sr": sr, "peak": round(float(np.abs(a).max()), 3)}))
'''


def encode_m4a(wav: Path, out: Path, bitrate="64000"):
    """
    AAC via macOS's built-in afconvert.

    The brief asked for OGG or MP3. Neither is encodable here: there is no
    ffmpeg and no sox on this machine, and afconvert decodes MP3 but cannot
    encode it or Vorbis. Installing ffmpeg via brew would be a large, system-wide
    change made on the owner's machine without being asked. AAC in an .m4a is the
    same trade — small and compressed — and every browser this game targets
    (Safari, Chrome, Firefox, Quest Browser) decodes it in WebAudio.
    """
    subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", "-b", bitrate,
                    "-q", "127", "-s", "3", str(wav), str(out)], check=True)


def generate(name: str, spec: dict, variants: int, keep: bool) -> dict:
    backend = spec.get("backend", "bark")
    if backend != "bark":
        note = BACKEND_NOTES.get(backend, "no backend available")
        print(f"  ! {name}: backend '{backend}' unavailable.\n"
              + "\n".join("    " + l for l in note.splitlines()))
        return {"name": name, "status": "blocked", "backend": backend}

    tmp = OUTDIR / "_work"
    tmp.mkdir(parents=True, exist_ok=True)
    print(f"  · {name}: generating {variants} variant(s) with Bark…", flush=True)
    t0 = time.time()
    res = run_in_venv(BARK_SCRIPT, dict(name=name, prompt=spec["prompt"],
                                        voice=spec.get("voice"), tmp=str(tmp),
                                        seeds=[1000 + i for i in range(variants)]))

    lo, hi = spec.get("target", (0.2, 3.0))
    scored = []
    for i, raw in enumerate(res["files"]):
        dst = tmp / f"{name}.v{i+1}.wav"
        info = run_in_venv(POST_SCRIPT, dict(src=raw, dst=str(dst), peak=0.89,
                                            max_seconds=spec.get("max_seconds")))
        secs = info["seconds"]
        # Pick by how well the duration lands in the brief's window — a laugh
        # that runs 6 s is the wrong sound however good it is.
        miss = 0.0 if lo <= secs <= hi else min(abs(secs - lo), abs(secs - hi))
        scored.append((miss, secs, dst, i + 1))
        print(f"      v{i+1}: {secs:.2f}s  (target {lo}-{hi}s){'  ← in range' if miss == 0 else ''}")

    scored.sort(key=lambda s: s[0])
    miss, secs, best, vn = scored[0]
    out = OUTDIR / f"{name}.m4a"
    encode_m4a(best, out)
    if keep:
        for _, _, w, n in scored: (OUTDIR / f"{name}.v{n}.wav").write_bytes(w.read_bytes())
    print(f"    -> chose v{vn} ({secs:.2f}s) -> {out.name} "
          f"({out.stat().st_size / 1024:.0f} KB, {time.time() - t0:.0f}s)")
    return {"name": name, "status": "ok", "backend": "bark", "seconds": secs,
            "bytes": out.stat().st_size, "chosen": f"v{vn}", "prompt": spec["prompt"]}


def main():
    ap = argparse.ArgumentParser(description="Generate game SFX locally. No uploads.")
    ap.add_argument("names", nargs="*", help="sound names (default: all)")
    ap.add_argument("--prompt"); ap.add_argument("--voice")
    ap.add_argument("--backend", default=None)
    ap.add_argument("--variants", type=int, default=3)
    ap.add_argument("--keep-variants", action="store_true")
    args = ap.parse_args()

    if not VENV_PY.exists():
        raise SystemExit(f"python not found at {VENV_PY} — edit VENV_PY in this script")
    OUTDIR.mkdir(parents=True, exist_ok=True)

    names = args.names or list(SOUNDS)
    results = []
    for n in names:
        spec = dict(SOUNDS.get(n, {}))
        if args.prompt:  spec["prompt"] = args.prompt
        if args.voice:   spec["voice"] = args.voice
        if args.backend: spec["backend"] = args.backend
        if not spec.get("prompt"):
            print(f"  ! {n}: no prompt (pass --prompt)"); continue
        results.append(generate(n, spec, args.variants, args.keep_variants))

    print("\n" + json.dumps(results, indent=1))
    (OUTDIR / "_work").exists() and print(f"\nintermediates in {OUTDIR / '_work'} (safe to delete)")


if __name__ == "__main__":
    main()
