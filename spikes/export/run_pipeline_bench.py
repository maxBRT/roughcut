"""Step 4 and 5: whole-export timings on the realistic sources.

- 12-clip edit (about 150 s of output), clip by clip, 1 and 2 pieces at a time
- the same edit as one single-pass ffmpeg run
- 1 clip of 120 s vs 60 clips of 2 s (same output length) to separate per-second and per-clip cost
"""
import json
import os
import sys

from common import MEDIA, gpu_state
from export import export
from alt_singlepass import run_singlepass

S = os.path.join(MEDIA, "src")
OUT = os.path.join(MEDIA, "pipe")
os.makedirs(OUT, exist_ok=True)
RES = os.path.join(OUT, "pipeline.json")

EDIT12 = [(300, 900), (3000, 45), (1210, 37), (4100, 600), (95, 160), (2650, 120),
          (4800, 590), (2000, 52), (5000, 33), (3400, 600), (1700, 233), (2300, 1000)]
ONE = [(1000, 3600)]
SIXTY = [((i * 89) % 5300, 60) for i in range(60)]


def main(args):
    codec_cq = {"h264": ("R264.mp4", int(os.environ.get("CQ_H264", 19))),
                "hevc": ("R265.mp4", int(os.environ.get("CQ_HEVC", 19)))}
    preset = os.environ.get("PRESET", "p7")
    res = json.load(open(RES)) if os.path.exists(RES) else {}
    for codec, (src, cq) in codec_cq.items():
        sp = os.path.join(S, src)
        cases = [("edit12_par1", EDIT12, 1), ("edit12_par2", EDIT12, 2),
                 ("one120_par1", ONE, 1), ("sixty2s_par1", SIXTY, 1), ("sixty2s_par2", SIXTY, 2),
                 ("edit12_singlepass", EDIT12, 0)]
        for name, edit, par in cases:
            key = f"{codec}_cq{cq}_{preset}_{name}"
            if args and not any(a in key for a in args):
                continue
            clips = [(sp, s, n) for s, n in edit]
            out = os.path.join(OUT, key + ".mp4")
            g = gpu_state()
            if par == 0:
                t = run_singlepass(clips, out, 30, codec, cq, preset=preset)
                t["out_seconds"] = sum(n for _, n in edit) / 30
                t["clips"] = len(edit)
            else:
                t = export(clips, out, 30, codec, cq, os.path.join(OUT, key + "_work"),
                           parallel=par, preset=preset)
            t["gpu_before"] = g
            t["x_realtime"] = round(t["out_seconds"] / t["total_s"], 2)
            t["work_s_per_out_s"] = round(t["total_s"] / t["out_seconds"], 3)
            t["bytes_per_out_s"] = round(t["bytes"] / t["out_seconds"])
            res[key] = t
            print(key, {k: (round(v, 2) if isinstance(v, float) else v) for k, v in t.items()
                        if k != "piece_times"}, flush=True)
            json.dump(res, open(RES, "w"), indent=1)
            os.remove(out)


if __name__ == "__main__":
    main(sys.argv[1:])
