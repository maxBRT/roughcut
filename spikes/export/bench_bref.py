"""Re-measure the chosen setting after the B-frame reference fix: encode the whole 3-minute realistic
source with the CURRENT export.video_settings (bench.encode), then measure quality (bench.quality)
and decode integrity (decode_check.decode). Speed figures from this script were taken while other
programs used the GPU; use bench.json for speed.

python bench_bref.py [codec:cq:preset ...]      default: h264:19:p4
Results: .cache-dev/export/bench/bench_bref.json, tag suffix "_brefoff" for H.264.
"""
import json
import os
import sys

from bench import OUT, S, encode, quality
from decode_check import decode

RES = os.path.join(OUT, "bench_bref.json")


def main(specs):
    res = json.load(open(RES)) if os.path.exists(RES) else {}
    for spec in specs or ["h264:19:p4"]:
        codec, cq, preset = spec.split(":")
        src = os.path.join(S, "R264.mp4" if codec == "h264" else "R265.mp4")
        tag, out, r = encode(codec, int(cq), preset, src, codec == "hevc")
        suffix = "_brefoff" if codec == "h264" else ""
        new_out = out.replace(".mp4", suffix + ".mp4")
        os.replace(out, new_out)
        tag += suffix
        r["note"] = "speed measured while other programs used the GPU"
        print(tag, json.dumps(r), flush=True)
        r["decode_check"] = decode(new_out)
        print("  decode", json.dumps(r["decode_check"]), flush=True)
        r["quality"] = quality(new_out, src, codec == "hevc", tag)
        print("  quality", json.dumps(r["quality"]), flush=True)
        res[tag] = r
        json.dump(res, open(RES, "w"), indent=1)


if __name__ == "__main__":
    main(sys.argv[1:])
