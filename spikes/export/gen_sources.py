"""Generate synthetic 4K30 test sources into .cache-dev/export/src.

numbered:  A1, A2  H.264 8-bit 4:2:0, 60 s, GOP 60, 2 B-frames, BT.709 tags
           B1, B2  HEVC Main10 4:2:0 (libx265), 60 s, GOP 60, 3 B-frames, HDR10 tags + mastering metadata
           V1      H.264, variable frame rate (irregular frame durations), 60 s wall clock
           N1      H.264 1920x1080 at 30000/1001, 40 s ("ntsc"; run with argument ntsc)
  Every frame: frame number as text, and a 16-block binary marker in the top 160 lines
  (bits 0-11 frame number, bits 12-15 source id).
  Audio track 1: stereo, 1 kHz beep 50 ms at every whole second.
  Audio track 2: mono, 3 kHz beep 50 ms at every half second (k + 0.5 s).
realistic: R264 (H.264 8-bit) and R265 (HEVC Main10), 180 s: 0-90 s screen-recording-like,
           90-180 s camera-like (moving detail + temporal grain). Two audio tracks.
"""
import os
import random
import shutil
import sys

from common import FFMPEG, MEDIA, run

SRC = os.path.join(MEDIA, "src")
os.makedirs(SRC, exist_ok=True)
os.chdir(SRC)
for f in ("arial.ttf", "consola.ttf"):
    if not os.path.exists(f):
        shutil.copy(os.path.join("C:/Windows/Fonts", f), f)

DUR = 60
BEEP_A = "0.5*sin(2*PI*1000*t)*lt(mod(t,1),0.05)"
BEEP_B = "0.5*sin(2*PI*3000*t)*lt(mod(t+0.5,1),0.05)"


SP709 = "setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709"
SPHDR = "setparams=range=tv:color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc"


def numbered_graph(sid, setpts=None, size="3840x2160", rate="30", dur=DUR):
    sp = SPHDR if sid in (3, 4) else SP709
    w, h = (int(x) for x in size.split("x"))
    mark = (f"nullsrc=s=16x2:r={rate}:d={dur},format=gray,"
            f"geq=lum='if(lt(X,12),255*mod(floor(N/pow(2,X)),2),255*mod(floor({sid}/pow(2,X-12)),2))',"
            f"scale={w}:{160 * h // 2160}:flags=neighbor[mk]")
    g = (f"testsrc2=s={size}:r={rate}:d={dur}[bg];{mark};"
         f"[bg][mk]overlay=0:0,drawtext=fontfile=arial.ttf:text='S{sid} F%{{frame_num}}':"
         f"fontsize={260 * h // 2160}:fontcolor=white:box=1:boxcolor=black@0.85:x=200:y={600 * h // 2160},{sp}")
    if setpts:
        g += f",setpts='{setpts}'"
    g += "[v];"
    g += (f"aevalsrc=exprs='{BEEP_A}|{BEEP_A}':s=48000:d={dur}[a1];"
          f"aevalsrc=exprs='{BEEP_B}':s=48000:d={dur}[a2]")
    return g


AUD = ["-c:a", "aac", "-b:a", "256k", "-ar", "48000"]
MAPS = ["-map", "[v]", "-map", "[a1]", "-map", "[a2]"]
H264_SRC = ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "16", "-b:v", "0",
            "-g", "60", "-bf", "2", "-pix_fmt", "yuv420p", "-color_primaries", "bt709",
            "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"]
X265_HDR = ("keyint=60:min-keyint=60:bframes=3:crf=16:repeat-headers=1:hdr10=1:hdr10-opt=0:"
            "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:range=limited:"
            "master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):"
            "max-cll=1000,400")
HEVC_SRC = ["-c:v", "libx265", "-preset", "superfast", "-pix_fmt", "yuv420p10le",
            "-x265-params", X265_HDR, "-tag:v", "hvc1", "-color_primaries", "bt2020",
            "-color_trc", "smpte2084", "-colorspace", "bt2020nc", "-color_range", "tv"]


def gen_numbered():
    jobs = [("A1.mp4", 1, H264_SRC, None), ("A2.mp4", 2, H264_SRC, None),
            ("B1.mp4", 3, HEVC_SRC, None), ("B2.mp4", 4, HEVC_SRC, None),
            # VFR: base 1/30 per frame, every 37th frame gap +2 frames (0.1 s frame), every 53rd -0.5 frame
            ("V1.mp4", 5, H264_SRC, "(N/30+floor(N/37)*2/30-floor(N/53)*0.5/30)/TB")]
    for name, sid, venc, setpts in jobs:
        if os.path.exists(name):
            continue
        extra = ["-fps_mode", "passthrough", "-video_track_timescale", "90000"] if setpts else \
                ["-video_track_timescale", "15360"]
        dt, _ = run([FFMPEG, "-hide_banner", "-y", "-filter_complex", numbered_graph(sid, setpts),
                     *MAPS, *venc, *AUD, *extra, *([] if setpts else ["-shortest"]),
                     "-movflags", "+faststart", name], label=f"gen {name}")
        print(f"{name}: {dt:.1f}s", flush=True)


def gen_ntsc():
    """N1: 1920x1080 at 30000/1001 (a frame is 1601.6 audio samples), 40 s, H.264, two audio tracks."""
    name = "N1.mp4"
    if os.path.exists(name):
        return
    dt, _ = run([FFMPEG, "-hide_banner", "-y", "-filter_complex",
                 numbered_graph(6, size="1920x1080", rate="30000/1001", dur=40),
                 *MAPS, *H264_SRC, *AUD, "-video_track_timescale", "30000", "-shortest",
                 "-movflags", "+faststart", name], label=f"gen {name}")
    print(f"{name}: {dt:.1f}s", flush=True)


def code_text():
    random.seed(7)
    words = ["export", "clip", "frame", "source", "sequence", "encode", "join", "audio",
             "track", "ramp", "timestamp", "piece", "nvenc", "quality", "result", "plan"]
    lines = []
    ind = 0
    for i in range(400):
        r = random.random()
        if r < 0.15 and ind < 4:
            lines.append("    " * ind + f"fn {random.choice(words)}_{random.choice(words)}"
                         f"(&mut self, {random.choice(words)}: u64) -> Result<()> {{")
            ind += 1
        elif r < 0.25 and ind > 0:
            ind -= 1
            lines.append("    " * ind + "}")
        elif r < 0.32:
            lines.append("")
        else:
            lines.append("    " * ind + f"let {random.choice(words)} = self.{random.choice(words)}"
                         f"({random.choice(words)}, {random.randint(0, 9999)}); "
                         f"// {random.choice(words)} {random.choice(words)}")
    with open("code.txt", "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    with open("files.txt", "w", encoding="utf-8") as f:
        f.write("\n".join(f"{random.choice(words)}_{random.choice(words)}.rs" for _ in range(40)))


def realistic_graph():
    screen = ("color=c=0x1e1e1e:s=3840x2160:r=30:d=90,"
              "drawbox=x=0:y=0:w=640:h=ih:color=0x252526:t=fill,"
              "drawbox=x=0:y=0:w=iw:h=70:color=0x333333:t=fill,"
              "drawtext=fontfile=consola.ttf:textfile=files.txt:fontsize=34:fontcolor=0xcccccc:"
              "x=40:y=120:line_spacing=14,"
              "drawtext=fontfile=consola.ttf:textfile=code.txt:fontsize=40:fontcolor=0xd4d4d4:"
              "x=700:y='100-mod(floor(t/6),9)*480':line_spacing=12,"
              "drawbox=x='720+mod(t*90,2600)':y='1300+300*sin(t/4)':w=22:h=40:color=white:t=fill,"
              "drawtext=fontfile=consola.ttf:text='%{pts\\:hms}':fontsize=36:fontcolor=white:x=3400:y=16,"
              "format=yuv420p[s]")
    camera = ("mandelbrot=s=960x540:r=30:start_scale=2.5:end_scale=0.05:end_pts=300:maxiter=1500,"
              "trim=duration=90,setpts=PTS-STARTPTS,"
              "scale=3840:2160:flags=bicubic,hue=s=0.55,"
              "noise=alls=7:allf=t,format=yuv420p[c]")
    aud = ("aevalsrc=exprs='0.25*sin(2*PI*170*t)*gt(sin(2*PI*1.3*t),0)+0.08*(random(0)-0.5)|"
           "0.25*sin(2*PI*171*t)*gt(sin(2*PI*1.3*t),0)+0.08*(random(1)-0.5)':s=48000:d=180[a1];"
           "aevalsrc=exprs='0.1*sin(2*PI*440*t)':s=48000:d=180[a2]")
    return f"{screen};{camera};[s][c]concat=n=2:v=1:a=0,{SP709}[v];{aud}"


def gen_realistic():
    code_text()
    jobs = [("R264.mp4", H264_SRC),
            ("R265.mp4", ["-c:v", "hevc_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "16",
                          "-b:v", "0", "-g", "60", "-bf", "3", "-profile:v", "main10",
                          "-pix_fmt", "p010le", "-tag:v", "hvc1", "-color_primaries", "bt709",
                          "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"])]
    # same deterministic graph rendered per codec (noise filter uses a fixed default seed)
    for name, venc in jobs:
        if os.path.exists(name):
            continue
        dt, _ = run([FFMPEG, "-hide_banner", "-y", "-filter_complex", realistic_graph(), *MAPS,
                     *venc, *AUD, "-video_track_timescale", "15360", "-movflags", "+faststart",
                     name], label=f"gen {name}")
        print(f"{name}: {dt:.1f}s", flush=True)


if __name__ == "__main__":
    what = sys.argv[1:] or ["numbered", "realistic"]
    if "numbered" in what:
        gen_numbered()
    if "realistic" in what:
        gen_realistic()
    if "ntsc" in what:
        gen_ntsc()
