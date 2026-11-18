"""Step 3 and 5: quality settings benchmark on the 3-minute realistic sources.

For each codec (H.264 source R264 -> h264_nvenc, HEVC 10-bit source R265 -> hevc_nvenc) and each
constant-quality value: encode the whole source as one piece (the same command as one export clip),
time it, measure size, then SSIM / PSNR (ffmpeg filters) and VMAF (libvmaf, 4K model) against the
source, separately for the screen-like half (frames 0-2699) and the camera-like half (2700-5399).
"""
import json
import os
import re
import sys
import time

from common import FFMPEG, MEDIA, gpu_state, probe, run
from export import piece_cmd, video_settings

S = os.path.join(MEDIA, "src")
OUT = os.path.join(MEDIA, "bench")
os.makedirs(OUT, exist_ok=True)
FRAMES = 5400
SPLIT = 2700
RESULTS = os.path.join(OUT, "bench.json")


def load():
    return json.load(open(RESULTS)) if os.path.exists(RESULTS) else {}


def save(r):
    json.dump(r, open(RESULTS, "w"), indent=1)


def quality(dist, ref, ten_bit, tag):
    pf = "yuv420p10le" if ten_bit else "yuv420p"
    os.chdir(OUT)  # stats file paths kept relative (filter-string escaping of drive letters)
    sl, pl, vl = f"{tag}.ssim.log", f"{tag}.psnr.log", f"{tag}.vmaf.json"
    graph = (f"[0:v]format={pf},split=3[d1][d2][d3];[1:v]format={pf},split=3[r1][r2][r3];"
             f"[d1][r1]ssim=stats_file={sl};[d2][r2]psnr=stats_file={pl};"
             f"[d3][r3]libvmaf=model=version=vmaf_4k_v0.6.1:n_threads=16:n_subsample=3:"
             f"log_fmt=json:log_path={vl}")
    dt, _ = run([FFMPEG, "-hide_banner", "-nostdin", "-v", "error", "-hwaccel", "cuda", "-i", dist,
                 "-hwaccel", "cuda", "-i", ref, "-lavfi", graph, "-f", "null", "-"],
                label=f"quality {tag}")
    seg = {"screen": {}, "camera": {}}

    def segname(i):
        return "screen" if i < SPLIT else "camera"
    acc = {k: {"ssim_all": [], "ssim_y": [], "psnr_y": [], "psnr_avg": [], "vmaf": []} for k in seg}
    for line in open(sl):
        n = int(re.search(r"n:(\d+)", line).group(1)) - 1
        acc[segname(n)]["ssim_all"].append(float(re.search(r"All:([\d.]+)", line).group(1)))
        acc[segname(n)]["ssim_y"].append(float(re.search(r"Y:([\d.]+)", line).group(1)))
    for line in open(pl):
        n = int(re.search(r"n:(\d+)", line).group(1)) - 1
        for k in ("psnr_y", "psnr_avg"):
            v = re.search(k + r":([\d.]+|inf)", line).group(1)
            acc[segname(n)][k].append(100.0 if v == "inf" else float(v))
    for fr in json.load(open(vl))["frames"]:
        acc[segname(fr["frameNum"])]["vmaf"].append(fr["metrics"]["vmaf"])
    for k, a in acc.items():
        for m, vals in a.items():
            if not vals:
                continue
            vs = sorted(vals)
            seg[k][m] = round(sum(vals) / len(vals), 5 if m.startswith("ssim") else 3)
            seg[k][m + "_p1"] = round(vs[max(0, int(len(vs) * 0.01) - 1)], 5 if m.startswith("ssim") else 3)
    seg["metric_seconds"] = round(dt, 1)
    return seg


def segment_sizes(path):
    """Bytes of video packets in each half (from ffprobe packet sizes)."""
    _, p = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                "packet=pts,size", "-of", "csv=p=0", path], capture=True)
    a = b = 0
    for line in p.stdout.decode().split():
        pts, size = line.split(",")[:2]
        if int(pts) < SPLIT * 512:
            a += int(size)
        else:
            b += int(size)
    return a, b


def encode(codec, cq, preset, src, ten_bit):
    tag = f"{codec}_cq{cq}_{preset}"
    out = os.path.join(OUT, tag + ".mp4")
    g0 = gpu_state()
    dt, _ = run(piece_cmd(src, 0, FRAMES, 30, video_settings(codec, cq, preset, 60, ten_bit), out),
                label=f"bench encode {tag}")
    g1 = gpu_state()
    size = os.path.getsize(out)
    a, b = segment_sizes(out)
    return tag, out, {
        "codec": codec, "cq": cq, "preset": preset, "encode_s": round(dt, 2),
        "fps": round(FRAMES / dt, 1), "x_realtime": round(FRAMES / 30 / dt, 2),
        "bytes": size, "MB_per_min": round(size / 1e6 / 3, 1), "Mbps": round(size * 8 / 180 / 1e6, 1),
        "Mbps_screen": round(a * 8 / 90 / 1e6, 1), "Mbps_camera": round(b * 8 / 90 / 1e6, 1),
        "gpu_before": g0, "gpu_after": g1}


def main(args):
    res = load()
    cqs = [16, 19, 22]
    plan = []
    for codec, src, ten in (("h264", "R264.mp4", False), ("hevc", "R265.mp4", True)):
        for cq in cqs:
            plan.append((codec, cq, "p7", src, ten, True))
        for preset in ("p5", "p4", "p1"):
            plan.append((codec, 19, preset, src, ten, preset != "p1"))
    for codec, cq, preset, src, ten, q in plan:
        tag = f"{codec}_cq{cq}_{preset}"
        if args and not any(a in tag for a in args):
            continue
        if tag in res and "quality" in res[tag]:
            continue
        srcp = os.path.join(S, src)
        tag, out, r = encode(codec, cq, preset, srcp, ten)
        print(tag, r, flush=True)
        if q:
            r["quality"] = quality(out, srcp, ten, tag)
            print("  ", r["quality"], flush=True)
        res[tag] = r
        save(res)
        if preset != "p7" or not q:
            pass
    # source bitrates for reference
    for name in ("R264.mp4", "R265.mp4"):
        p = os.path.join(S, name)
        a, b = segment_sizes(p)
        res["source_" + name] = {"bytes": os.path.getsize(p), "Mbps_screen": round(a * 8 / 90 / 1e6, 1),
                                 "Mbps_camera": round(b * 8 / 90 / 1e6, 1)}
    save(res)


if __name__ == "__main__":
    main(sys.argv[1:])
