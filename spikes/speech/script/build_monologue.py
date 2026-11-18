"""Joins the per-line TTS WAVs into one monologue with known silences, and writes the ground truth.

Usage: python build_monologue.py <monologue.json> <linesDir> <outDir> <truthJson>

Outputs (16 kHz mono 16-bit):
  monologue_clean.wav  - speech + very low noise floor (-70 dBFS) in silences
  monologue_noisy.wav  - same plus steady background noise at about -42 dBFS RMS
                         and a few keyboard-like clicks inside the 6 s and 8 s silences
Ground truth: for every line its start and end (first/last sample above -50 dBFS within the
line's own WAV, so trailing TTS silence is not counted), and word start times from the
synthesizer's SpeakProgress positions shifted by the same offset.
"""
import json, sys
import numpy as np
import soundfile as sf

SR = 16000
LEAD_IN = 2.0

def trim_bounds(x):
    frame = 160  # 10 ms
    n = len(x) // frame
    rms = np.sqrt(np.mean(x[: n * frame].reshape(n, frame) ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms + 1e-12)
    idx = np.where(db > -50)[0]
    if len(idx) == 0:
        return 0, len(x)
    return idx[0] * frame, min(len(x), (idx[-1] + 1) * frame)

def main():
    cfg = json.load(open(sys.argv[1], encoding="utf-8"))
    lines_dir, out_dir, truth_path = sys.argv[2], sys.argv[3], sys.argv[4]
    words_info = json.load(open(f"{lines_dir}/lines_words.json", encoding="utf-8-sig"))
    rng = np.random.default_rng(1234)
    pieces = [np.zeros(int(LEAD_IN * SR), dtype=np.float32)]
    t = LEAD_IN
    truth = []
    click_spans = []
    for i, line in enumerate(cfg["lines"]):
        x, sr = sf.read(f"{lines_dir}/line{i:03d}.wav", dtype="float32")
        assert sr == SR
        a, b = trim_bounds(x)
        seg = x[a:b]
        start = t
        end = t + len(seg) / SR
        words = []
        for w in words_info[i]["words"]:
            ws = start + max(0.0, (w["pos_ms"] / 1000.0) - a / SR)
            words.append({"text": w["text"], "start": round(ws, 3)})
        truth.append({
            "index": i, "text": line["text"], "kind": line["kind"],
            "start": round(start, 3), "end": round(end, 3),
            "pause_after": line["pause_after"], "words_start_approx": words,
        })
        pieces.append(seg)
        gap = np.zeros(int(line["pause_after"] * SR), dtype=np.float32)
        if line["pause_after"] >= 6.0:
            click_spans.append((end, end + line["pause_after"]))
        pieces.append(gap)
        t = end + len(gap) / SR
    clean = np.concatenate(pieces)
    floor = rng.normal(0, 10 ** (-70 / 20), len(clean)).astype(np.float32)
    clean_out = clean + floor
    # Noisy variant: brown-ish noise (fan / room) + clicks inside long silences
    white = rng.normal(0, 1, len(clean)).astype(np.float32)
    brown = np.cumsum(white)
    brown = brown - np.convolve(brown, np.ones(4000) / 4000, mode="same")
    brown = brown / (np.sqrt(np.mean(brown ** 2)) + 1e-9) * 10 ** (-42 / 20)
    noisy = clean + brown.astype(np.float32)
    clicks = []
    for (s, e) in click_spans:
        for k in range(4):
            ct = s + 1.0 + k * (e - s - 2.0) / 4
            ci = int(ct * SR)
            burst = rng.normal(0, 0.15, 160).astype(np.float32) * np.exp(-np.arange(160) / 25.0).astype(np.float32)
            noisy[ci : ci + 160] += burst
            clicks.append(round(ct, 3))
    sf.write(f"{out_dir}/monologue_clean.wav", np.clip(clean_out, -1, 1), SR, subtype="PCM_16")
    sf.write(f"{out_dir}/monologue_noisy.wav", np.clip(noisy, -1, 1), SR, subtype="PCM_16")
    json.dump({
        "description": "Ground truth for monologue_clean.wav / monologue_noisy.wav (seconds). Line start/end are measured from the audio (-50 dBFS threshold). Word starts are the synthesizer's own SpeakProgress positions and are approximate (tens of ms).",
        "duration": round(len(clean) / SR, 3),
        "noisy_variant_clicks_at": clicks,
        "lines": truth,
    }, open(truth_path, "w", encoding="utf-8"), indent=1)
    print("duration", len(clean) / SR, "lines", len(truth))

main()
