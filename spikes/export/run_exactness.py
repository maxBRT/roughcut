"""Step 2: export the 12-clip edit list from the numbered sources and check exactness.

python run_exactness.py [case ...]   cases: h264_A hevc10_hdr_B vfr_V ntsc_N h264_A_nodurlines
Results go to .cache-dev/export/exact/exactness_final.json (merged with earlier cases in that file).
"""
import json
import os
import sys
from fractions import Fraction

from common import FFPROBE, MEDIA, gpu_state, run
from export import export
from verify import check

S = os.path.join(MEDIA, "src")
OUT = os.path.join(MEDIA, "exact")
os.makedirs(OUT, exist_ok=True)

# (source key, start frame, frame count). Out of order, short and long, starts mostly off keyframes
# (sources have a keyframe every 60 frames; 1500 is on one).
EDIT = [(1, 100, 300), (2, 913, 37), (1, 1201, 39), (1, 37, 62), (2, 61, 400), (1, 1500, 17),
        (2, 1700, 99), (1, 400, 1), (2, 1000, 300), (1, 777, 53), (2, 5, 42), (1, 1745, 55)]
# 30000/1001 source (1198 frames): a frame is 1601.6 audio samples, so sample edges must be cumulative.
NTSC_EDIT = [(1, 500, 101), (1, 7, 33), (1, 1100, 97), (1, 61, 1), (1, 777, 250), (1, 300, 59),
             (1, 1000, 29), (1, 123, 177)]
VFR_EDIT = [(1, 30, 200), (1, 1300, 45), (1, 700, 13), (1, 401, 150), (1, 1000, 260), (1, 1600, 170)]


def side_data(path):
    _, p = run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1",
                "-show_frames", "-show_entries", "frame=side_data_list", "-of", "json", path],
               capture=True)
    fr = json.loads(p.stdout)["frames"]
    return [sd.get("side_data_type") for sd in fr[0].get("side_data_list", [])] if fr else []


def main(which):
    results = {}
    cases = {
        "h264_A": ({1: "A1.mp4", 2: "A2.mp4"}, EDIT, "h264", False),
        "hevc10_hdr_B": ({1: "B1.mp4", 2: "B2.mp4"}, EDIT, "hevc", False),
        "vfr_V": ({1: "V1.mp4"}, VFR_EDIT, "h264", True),
        "ntsc_N": ({1: "N1.mp4"}, NTSC_EDIT, "h264", False),
        # same as h264_A but the concat list carries no "duration" lines
        "h264_A_nodurlines": ({1: "A1.mp4", 2: "A2.mp4"}, EDIT, "h264", False),
    }
    fps_of = {"ntsc_N": Fraction(30000, 1001)}
    path = os.path.join(OUT, "exactness_final.json")
    if os.path.exists(path):
        results = json.load(open(path))
    for name, (srcs, edit, codec, vfr) in cases.items():
        if which and name not in which:
            continue
        paths = {k: os.path.join(S, v) for k, v in srcs.items()}
        clips = [(paths[k], s, n) for k, s, n in edit]
        sid_of = {paths[k]: int({"A1": 1, "A2": 2, "B1": 3, "B2": 4, "V1": 5, "N1": 6}[v[:2]])
                  for k, v in srcs.items()}
        out = os.path.join(OUT, f"{name}.mp4")
        g0 = gpu_state()
        fps = fps_of.get(name, Fraction(30))
        t = export(clips, out, fps, codec, 19, os.path.join(OUT, name + "_work"),
                   durations_in_list=not name.endswith("nodurlines"))
        r = check(out, clips, fps, sid_of, vfr=vfr)
        r["timing"] = t
        r["gpu_before"] = g0
        r["first_frame_side_data"] = side_data(out)
        results[name] = r
        print(name, json.dumps({k: r[k] for k in ("decoded_frames", "expected_frames",
                                                  "marker_mismatches", "cuts_ok", "pts_regular",
                                                  "dts_strictly_increasing")}), flush=True)
        with open(path, "w") as f:
            json.dump(results, f, indent=1, default=str)


if __name__ == "__main__":
    main(sys.argv[1:])
