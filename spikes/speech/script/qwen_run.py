"""Qwen3-ASR-1.7B + Qwen3-ForcedAligner-0.6B over the test audio, VAD-split like the product.

Usage: python qwen_run.py <qwenDir> <wav> <outJsonl> <speechRangesFromJsonl> [device=cuda:0]

To compare like with like it reuses the speech ranges Silero VAD found in a Parakeet run
(the `done` message of <speechRangesFromJsonl>), pads each by 0.25 s, transcribes them in batches
and aligns each one. Output uses the same JSON-lines shape as the spike transcriber.
"""
import json, sys, time
import numpy as np
import soundfile as sf
import torch
from qwen_asr import Qwen3ASRModel

qdir, wav, out, ranges_from = sys.argv[1:5]
device = sys.argv[5] if len(sys.argv) > 5 else "cuda:0"
SR = 16000
audio, sr = sf.read(wav, dtype="float32")
assert sr == SR
speech = [json.loads(l) for l in open(ranges_from, encoding="utf-8") if '"done"' in l][0]["speech"]

t0 = time.time()
model = Qwen3ASRModel.from_pretrained(
    f"{qdir}/Qwen3-ASR-1.7B",
    dtype=torch.bfloat16 if device.startswith("cuda") else torch.float32,
    device_map=device,
    max_inference_batch_size=8,
    max_new_tokens=256,
    forced_aligner=f"{qdir}/Qwen3-ForcedAligner-0.6B",
    forced_aligner_kwargs=dict(dtype=torch.bfloat16 if device.startswith("cuda") else torch.float32, device_map=device),
)
load = time.time() - t0
pad = int(0.25 * SR)
chunks, offs = [], []
for s in speech:
    a = max(0, int(s["start"] * SR) - pad); b = min(len(audio), int(s["end"] * SR) + pad)
    chunks.append((audio[a:b], SR)); offs.append(a / SR)
t1 = time.time()
results = []
B = 8
for i in range(0, len(chunks), B):
    results += model.transcribe(audio=chunks[i:i + B], language=["English"] * len(chunks[i:i + B]), return_time_stamps=True)
dec = time.time() - t1
with open(out, "w", encoding="utf-8") as f:
    f.write(json.dumps({"type": "ready", "model": "Qwen3-ASR-1.7B+Qwen3-ForcedAligner-0.6B", "device": device, "load_seconds": load}) + "\n")
    for s, off, r in zip(speech, offs, results):
        words = [{"text": w.text, "start": round(off + w.start_time, 3), "end": round(off + w.end_time, 3)} for w in (r.time_stamps or [])]
        if words:
            f.write(json.dumps({"type": "segment", "start": s["start"], "end": s["end"], "text": r.text, "words": words}) + "\n")
        else:
            f.write(json.dumps({"type": "speech_without_words", "start": s["start"], "end": s["end"], "text": r.text}) + "\n")
    dur = len(audio) / SR
    f.write(json.dumps({"type": "done", "speech": speech, "stats": {"audio_seconds": dur, "model_load_seconds": load,
            "decode_seconds": dec, "speed_x_realtime_excluding_load": dur / dec}}) + "\n")
print("load", load, "decode", dec, "x realtime", len(audio) / SR / dec)
