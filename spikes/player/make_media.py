"""Player spike: build the test media and the proxies, timing each step.

Usage:  python make_media.py [--only originals|proxies|h264_10bit]
Writes into <project>/.cache-dev/player/ and appends timings to timings.json there.

Every frame carries:
  * a machine-readable marker in the top-left corner: two rows of 13 blocks
    (block = 120x120 px at 4K, 40x40 px in the 720p proxy). Row 1 is the frame
    number in binary (MSB first, white = 1), row 2 is its complement. A frame
    decodes as valid only if every pair is complementary, so blended or torn
    frames are detected instead of misread.
  * the frame number and time burned in as large text.
Audio (stereo, 48 kHz): left = 1 kHz beep for the first 100 ms of every second,
right = a continuous 440 Hz tone at -6 dB (used to measure gaps at cuts).
"""
import json, os, subprocess, sys, time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, ".cache-dev", "player")
os.makedirs(OUT, exist_ok=True)

FPS = 30
DUR = 120          # seconds
BITS = 13          # up to 8191 frames
BLOCK = 120        # px at 3840x2160 -> 40 px at 1280x720


def marker_filters():
    f = [f"drawbox=x=0:y=0:w={BITS*BLOCK}:h={2*BLOCK}:color=black:t=fill"]
    for k in range(BITS):
        bit = BITS - 1 - k                      # MSB first, left to right
        x = k * BLOCK
        on = f"eq(mod(floor(n/{2**bit}),2),1)"
        off = f"eq(mod(floor(n/{2**bit}),2),0)"
        f.append(f"drawbox=x={x}:y=0:w={BLOCK}:h={BLOCK}:color=white:t=fill:enable='{on}'")
        f.append(f"drawbox=x={x}:y={BLOCK}:w={BLOCK}:h={BLOCK}:color=white:t=fill:enable='{off}'")
    return f


def video_graph(w=3840, h=2160):
    chain = [f"testsrc2=s={w}x{h}:r={FPS}:d={DUR}"] + marker_filters() + [
        "drawtext=fontfile='C\\:/Windows/Fonts/consola.ttf':fontsize=220:fontcolor=white:box=1:boxcolor=black@0.7:"
        "x=40:y=300:text='F %{frame_num}   %{pts\\:hms}'"
    ]
    return ",".join(chain)


AUDIO = (
    f"sine=frequency=1000:sample_rate=48000:duration={DUR},"
    "volume=0:enable='gte(mod(t,1),0.1)'[l];"
    f"sine=frequency=440:sample_rate=48000:duration={DUR},volume=0.5[r];"
    "[l][r]join=inputs=2:channel_layout=stereo[a]"
)


def run(name, cmd, source_seconds=None):
    print(">>", name)
    print(" ".join(cmd))
    t0 = time.perf_counter()
    subprocess.run(cmd, check=True)
    dt = time.perf_counter() - t0
    rec = {"name": name, "seconds": round(dt, 2), "cmd": cmd}
    if source_seconds:
        rec["seconds_per_source_minute"] = round(dt / (source_seconds / 60), 2)
    path = os.path.join(OUT, "timings.json")
    data = json.load(open(path)) if os.path.exists(path) else []
    data = [d for d in data if d["name"] != name] + [rec]
    json.dump(data, open(path, "w"), indent=1)
    print(f"   took {dt:.1f}s")


def originals():
    vg = video_graph()
    fc = f"{vg},split=3[v1][v2][v3];" + AUDIO.replace("[a]", ",asplit=3[a1][a2][a3]")
    enc_common = ["-preset", "p5", "-rc", "vbr", "-b:v", "50M", "-maxrate", "80M", "-bufsize", "100M", "-g", "60"]
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-stats",
           "-filter_complex", fc,
           "-map", "[v1]", "-map", "[a1]", "-c:v", "h264_nvenc", *enc_common, "-profile:v", "high",
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
           os.path.join(OUT, "orig_h264_8bit.mp4"),
           "-map", "[v2]", "-map", "[a2]", "-c:v", "hevc_nvenc", *enc_common, "-profile:v", "main",
           "-pix_fmt", "yuv420p", "-tag:v", "hvc1", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
           os.path.join(OUT, "orig_hevc_8bit.mp4"),
           "-map", "[v3]", "-map", "[a3]", "-c:v", "hevc_nvenc", *enc_common, "-profile:v", "main10",
           "-pix_fmt", "p010le", "-tag:v", "hvc1", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
           os.path.join(OUT, "orig_hevc_10bit.mp4")]
    run("make_originals", cmd)


def h264_10bit():
    # Only 30 s: libx264 at 4K 10-bit is slow, and this file only answers "does it play".
    vg = video_graph().replace(f"d={DUR}", "d=30")
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-stats",
           "-filter_complex", f"{vg}[v];{AUDIO.replace(f'duration={DUR}', 'duration=30')}",
           "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20",
           "-profile:v", "high10", "-pix_fmt", "yuv420p10le", "-g", "60",
           "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
           os.path.join(OUT, "orig_h264_10bit.mp4")]
    run("make_h264_10bit", cmd)


# ---- The proxy command (spec 2.4.2). {FPS} = the source frame rate, {GOP} = round(FPS/2).
def proxy_cmd_gpu(src, dst, fps=FPS):
    gop = max(1, round(fps / 2))
    return ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-stats",
            "-hwaccel", "cuda", "-hwaccel_output_format", "cuda",
            "-i", src,
            "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", f"scale_cuda=w=1280:h=720:format=yuv420p:interp_algo=bilinear",
            "-fps_mode", "cfr", "-r", str(fps),
            "-c:v", "h264_nvenc", "-preset", "p4", "-profile:v", "high",
            "-rc", "vbr", "-cq", "25", "-b:v", "2500k", "-maxrate", "5M", "-bufsize", "5M",
            "-g", str(gop), "-keyint_min", str(gop), "-bf", "0", "-forced-idr", "1",
            "-force_key_frames", "expr:gte(t,n_forced*0.5)",
            "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000",
            "-movflags", "+faststart", dst]


def proxy_cmd_cpu(src, dst, fps=FPS):
    gop = max(1, round(fps / 2))
    return ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-stats",
            "-i", src,
            "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", "scale=1280:720:flags=bilinear,format=yuv420p",
            "-fps_mode", "cfr", "-r", str(fps),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-profile:v", "high",
            "-g", str(gop), "-keyint_min", str(gop), "-bf", "0", "-sc_threshold", "0",
            "-force_key_frames", "expr:gte(t,n_forced*0.5)",
            "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000",
            "-movflags", "+faststart", dst]


def proxies():
    for kind in ["h264_8bit", "hevc_8bit", "hevc_10bit"]:
        src = os.path.join(OUT, f"orig_{kind}.mp4")
        run(f"proxy_gpu_{kind}", proxy_cmd_gpu(src, os.path.join(OUT, f"proxy_{kind}.mp4")), DUR)
        run(f"proxy_cpu_{kind}", proxy_cmd_cpu(src, os.path.join(OUT, f"proxy_cpu_{kind}.mp4")), DUR)


if __name__ == "__main__":
    only = sys.argv[2] if len(sys.argv) > 2 and sys.argv[1] == "--only" else None
    if only in (None, "originals"):
        originals()
    if only in (None, "h264_10bit"):
        h264_10bit()
    if only in (None, "proxies"):
        proxies()
