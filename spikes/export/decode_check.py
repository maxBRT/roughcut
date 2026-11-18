"""Decode-integrity check. Each file is decoded twice: by libavcodec on the processor and by NVDEC
on the GPU (frames downloaded unchanged). The check records every decoder error line and compares the
CRC of every decoded frame between the two decoders. A clean, conforming stream gives no error lines
and identical frames (both decoders are bit-exact for a conforming stream).

python decode_check.py FILE [FILE ...]      (several files are decoded in parallel)
Results are merged into .cache-dev/export/check/decode_check.json, keyed by file name.
"""
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from common import FFMPEG, MEDIA, run

OUT = os.path.join(MEDIA, "check")
os.makedirs(OUT, exist_ok=True)
RES = os.path.join(OUT, "decode_check.json")


def crcs(path, gpu):
    """(per-frame CRC list, decoder error lines) from one decode of the first video stream."""
    # Both paths end in the NVDEC output layout (nv12 / p010le); the CPU path converts its planar
    # output to it, which is a lossless reordering of the same samples.
    pf = "p010le" if "10" in path_pix_fmt(path) else "nv12"
    if gpu:
        dec = ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]
        conv = ["-vf", f"hwdownload,format={pf}"]
    else:
        dec = ["-threads", "8"]
        conv = ["-pix_fmt", pf]
    _, p = run([FFMPEG, "-hide_banner", "-nostdin", "-v", "error", *dec, "-i", path, "-map", "0:v:0",
                *conv, "-f", "framecrc", "-"],
               label=f"decode check {'gpu' if gpu else 'cpu'} {os.path.basename(path)}",
               capture=True, check=False)
    rows = [line.split(",")[-1].strip() for line in p.stdout.decode(errors="replace").splitlines()
            if line and not line.startswith("#")]
    errs = [line for line in p.stderr.decode(errors="replace").splitlines() if line.strip()]
    return rows, errs


_PF = {}


def path_pix_fmt(path):
    if path not in _PF:
        from common import probe
        _PF[path] = next(s for s in probe(path)["streams"] if s["codec_type"] == "video")["pix_fmt"]
    return _PF[path]


def decode(path):
    """Return frame counts, error lines and CPU/GPU decoder disagreement for one file."""
    t0 = time.perf_counter()
    cpu, cerr = crcs(path, False)
    gpu, gerr = crcs(path, True)
    diff = [i for i in range(max(len(cpu), len(gpu)))
            if (cpu[i] if i < len(cpu) else None) != (gpu[i] if i < len(gpu) else None)]
    ranges = []
    for i in diff:
        if ranges and ranges[-1][1] == i - 1:
            ranges[-1][1] = i
        else:
            ranges.append([i, i])
    return {"seconds": round(time.perf_counter() - t0, 1), "frames_cpu": len(cpu),
            "frames_gpu": len(gpu), "cpu_error_lines": len(cerr), "cpu_first_errors": cerr[:4],
            "gpu_error_lines": len(gerr), "gpu_first_errors": gerr[:4],
            "frames_cpu_ne_gpu": len(diff), "differing_ranges": ranges[:20]}


def main(files):
    res = json.load(open(RES)) if os.path.exists(RES) else {}
    with ThreadPoolExecutor(max_workers=min(4, len(files))) as ex:
        for f, r in zip(files, ex.map(decode, files)):
            res[os.path.basename(f)] = r
            print(os.path.basename(f), json.dumps(r), flush=True)
    json.dump(res, open(RES, "w"), indent=1)


if __name__ == "__main__":
    main(sys.argv[1:])
