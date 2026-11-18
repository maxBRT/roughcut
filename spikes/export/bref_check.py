"""Does an NVENC setting make streams that the processor decoder (libavcodec) and NVDEC decode
differently? Encodes one piece of the realistic source with each variant (the export.piece_cmd
command, only the B-frame reference mode changed) and runs decode_check.decode on it.

python bref_check.py [--speed] [start_frame n_frames [variant ...]]
    --speed: encode only (no decode check), delete the output, record seconds and size; use it
    for paired speed comparisons run back to back under the same GPU conditions.
    variants: h264_middle h264_disabled hevc_middle hevc_disabled   (default: all four)
    default range: frames 3600..3899 of R264 / R265 (contains frame 3764, where the full-length
    h264 cq19 p4 encode with b_ref_mode middle decodes differently on CPU and GPU).
Results are merged into .cache-dev/export/check/bref_check.json.
"""
import json
import os
import sys

from common import MEDIA, gpu_state, run
from decode_check import decode
from export import piece_cmd, video_settings

OUT = os.path.join(MEDIA, "check")
RES = os.path.join(OUT, "bref_check.json")
SRC = {"h264": os.path.join(MEDIA, "src", "R264.mp4"), "hevc": os.path.join(MEDIA, "src", "R265.mp4")}


def vset_with(codec, mode, cq=19, preset="p4"):
    """export.video_settings with -b_ref_mode replaced by `mode`."""
    v = video_settings(codec, cq, preset, 60, codec == "hevc")
    v[v.index("-b_ref_mode") + 1] = mode
    return v


def main(args):
    speed = "--speed" in args
    args = [a for a in args if a != "--speed"]
    start, n = (int(args[0]), int(args[1])) if len(args) >= 2 else (3600, 300)
    variants = args[2:] or ["h264_middle", "h264_disabled", "hevc_middle", "hevc_disabled"]
    res = json.load(open(RES)) if os.path.exists(RES) else {}
    for var in variants:
        codec, mode = var.split("_")
        key = f"{var}_{start}_{n}"
        out = os.path.join(OUT, key + ".mp4")
        g = gpu_state()
        dt, _ = run(piece_cmd(SRC[codec], start, n, 30, vset_with(codec, mode), out),
                    label=f"bref {key}")
        r = {} if speed else decode(out)
        r.update({"encode_s": round(dt, 2), "x_realtime": round(n / 30 / dt, 2),
                  "bytes": os.path.getsize(out), "gpu_before": g, "gpu_after": gpu_state()})
        if speed:
            key += "_speed"
            os.remove(out)
        res[key] = r
        print(key, json.dumps(r), flush=True)
        json.dump(res, open(RES, "w"), indent=1)


if __name__ == "__main__":
    main(sys.argv[1:])
