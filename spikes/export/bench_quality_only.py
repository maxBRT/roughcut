"""Add SSIM / PSNR / VMAF to bench.json entries that were encoded without them (the p1 presets).

Measures only quality of files already in .cache-dev/export/bench; it does not re-encode, so no
speed figure in bench.json changes.  python bench_quality_only.py [tag ...]
"""
import os
import sys

from bench import OUT, S, load, quality, save


def main(tags):
    res = load()
    for tag, r in res.items():
        if tag.startswith("source_") or "quality" in r or (tags and tag not in tags):
            continue
        out = os.path.join(OUT, tag + ".mp4")
        if not os.path.exists(out):
            print(tag, "encode missing, skipped", flush=True)
            continue
        src = os.path.join(S, "R264.mp4" if r["codec"] == "h264" else "R265.mp4")
        r["quality"] = quality(out, src, r["codec"] == "hevc", tag)
        r["quality_note"] = "measured later by bench_quality_only.py on the same encode"
        print(tag, r["quality"], flush=True)
        save(res)


if __name__ == "__main__":
    main(sys.argv[1:])
