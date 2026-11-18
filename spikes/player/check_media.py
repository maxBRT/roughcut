"""Player spike: verify a file frame-by-frame with ffmpeg (no browser).

  python check_media.py <file.mp4>

Decodes the binary marker of every frame and checks frame k carries number k
(i.e. the proxy did not drop, duplicate or shift frames), and lists keyframe spacing.
"""
import subprocess, sys, json

BITS = 13


def markers(path):
    # Crop the marker area (26 blocks) whatever the resolution, shrink to 13x2 gray pixels.
    vf = f"crop=iw*{BITS*120}/3840:ih*240/2160:0:0,scale={BITS}:2:flags=area,format=gray"
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vf", vf, "-f", "rawvideo", "-"],
                       capture_output=True, check=True)
    raw, n = p.stdout, BITS * 2
    out = []
    for i in range(len(raw) // n):
        row1, row2 = raw[i*n:i*n+BITS], raw[i*n+BITS:i*n+n]
        if any(abs(a - b) < 128 for a, b in zip(row1, row2)):
            out.append(None)
            continue
        v = 0
        for a in row1:
            v = v * 2 + (1 if a > 128 else 0)
        out.append(v)
    return out


def keyframes(path):
    p = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey",
                        "-show_entries", "frame=pts_time", "-of", "csv=p=0", path],
                       capture_output=True, text=True, check=True)
    return [float(x.strip(",")) for x in p.stdout.split() if x.strip(",")]


if __name__ == "__main__":
    path = sys.argv[1]
    m = markers(path)
    bad = [(i, v) for i, v in enumerate(m) if v != i]
    k = keyframes(path)
    gaps = sorted({round(b - a, 3) for a, b in zip(k, k[1:])})
    print(json.dumps({"file": path, "frames": len(m), "mismatched": len(bad), "first_mismatches": bad[:5],
                      "keyframes": len(k), "keyframe_spacing_s": gaps}))
