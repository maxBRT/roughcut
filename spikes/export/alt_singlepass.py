"""Step 4: single-pass alternative. One ffmpeg run: every clip is its own GPU-decoded input,
a filter graph trims each one and concatenates them, the result is encoded once (video and audio).

python alt_singlepass.py                 the 12-clip edit of run_exactness (A1/A2), checked for exactness
Also samples total GPU memory every 0.25 s during the run (per-process memory is not reported on
WDDM, so the peak minus the level before the run is an approximation if other programs use the GPU).
Results: .cache-dev/export/alt/singlepass_*_final.json
"""
import subprocess
import threading
import json
import os
import sys
import time
from fractions import Fraction

from common import FFMPEG, MEDIA, gpu_state, probe, run
from export import AUDIO_RATE, RAMP, fmt_t, timescale, video_settings
from verify import check


def singlepass_cmd(clips, fps, codec, cq, out, layouts, ten_bit, preset="p4", hw_concat=True):
    fps = Fraction(fps)
    args = [FFMPEG, "-hide_banner", "-nostdin", "-y", "-v", "error"]
    for src, start, n in clips:
        seek = max(0.0, float(start / fps) - 1.0)
        args += ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda", "-noaccurate_seek",
                 "-ss", fmt_t(seek), "-copyts", "-i", src]
    ch, vl, al = [], [], []
    spf = Fraction(AUDIO_RATE) / fps
    for i, (src, start, n) in enumerate(clips):
        dl = "" if hw_concat else ",hwdownload,format=" + ("p010le" if ten_bit else "nv12")
        ch.append(f"[{i}:v:0]fps={fps.numerator}/{fps.denominator},trim=start_pts={start}:"
                  f"end_pts={start + n},setpts=PTS-STARTPTS{dl}[v{i}]")
        vl.append(f"[v{i}]")
        a0, a1 = int(start * spf), int((start + n) * spf)
        dur = Fraction(a1 - a0, AUDIO_RATE)
        for t, lay in enumerate(layouts):
            ch.append(f"[{i}:a:{t}]aresample={AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts={lay},"
                      f"asettb=1/{AUDIO_RATE},atrim=start_pts={a0}:end_pts={a1},asetpts=PTS-STARTPTS,"
                      f"afade=t=in:d={fmt_t(RAMP)},afade=t=out:st={fmt_t(dur - RAMP)}:d={fmt_t(RAMP)}"
                      f"[a{i}t{t}]")
    inter = "".join(f"[v{i}]" + "".join(f"[a{i}t{t}]" for t in range(len(layouts)))
                    for i in range(len(clips)))
    outs = "[v]" + "".join(f"[o{t}]" for t in range(len(layouts)))
    graph = ";".join(ch) + ";" + inter + f"concat=n={len(clips)}:v=1:a={len(layouts)}{outs}"
    args += ["-filter_complex", graph, "-map", "[v]"]
    for t in range(len(layouts)):
        args += ["-map", f"[o{t}]"]
    args += ["-fps_mode", "passthrough", *video_settings(codec, cq, preset, 60, ten_bit),
             "-c:a", "aac", "-b:a", "256k", "-video_track_timescale", str(timescale(fps)),
             "-movie_timescale", str(timescale(fps)), "-map_metadata", "-1",
             "-movflags", "+faststart", out]
    return args


def layouts_of(src):
    info = probe(src)
    return [s.get("channel_layout") or ("stereo" if s["channels"] == 2 else "mono")
            for s in info["streams"] if s["codec_type"] == "audio"], \
        "10" in next(s for s in info["streams"] if s["codec_type"] == "video")["pix_fmt"]


def gpu_mem_mib():
    p = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
    return int(p.stdout.decode().split()[0])


class MemSampler:
    """Peak of total GPU memory while a block runs."""
    def __enter__(self):
        self.before = gpu_mem_mib()
        self.peak = self.before
        self.stop = threading.Event()
        self.t = threading.Thread(target=self._loop, daemon=True)
        self.t.start()
        return self

    def _loop(self):
        while not self.stop.wait(0.25):
            try:
                self.peak = max(self.peak, gpu_mem_mib())
            except Exception:  # noqa
                pass

    def __exit__(self, *a):
        self.stop.set()
        self.t.join()


def run_singlepass(clips, out, fps, codec, cq, hw_concat=True, preset="p4"):
    lay, ten = layouts_of(clips[0][0])
    g = gpu_state()
    with MemSampler() as m:
        dt, p = run(singlepass_cmd(clips, fps, codec, cq, out, lay, ten, preset, hw_concat),
                    label="singlepass", check=False)
    r = {"total_s": dt, "gpu_before": g, "gpu_mem_before_mib": m.before,
         "gpu_mem_peak_mib": m.peak, "gpu_mem_delta_mib": m.peak - m.before,
         "returncode": p.returncode, "bytes": os.path.getsize(out) if os.path.exists(out) else 0}
    if p.returncode != 0:
        r["stderr_tail"] = p.stderr.decode(errors="replace")[-1500:]
    return r


if __name__ == "__main__":
    from run_exactness import EDIT, S
    from export import export
    OUT = os.path.join(MEDIA, "alt")
    os.makedirs(OUT, exist_ok=True)
    paths = {1: os.path.join(S, "A1.mp4"), 2: os.path.join(S, "A2.mp4")}
    # Measured: about 490 MB of GPU memory per GPU-decoded 4K input, so do not raise the clip count
    # here without checking free GPU memory first (12 clips took 5.9 GB).
    edit, name = EDIT, "singlepass_A"
    clips = [(paths[k], s, n) for k, s, n in edit]
    out = os.path.join(OUT, name + ".mp4")
    hw = "--download" not in sys.argv
    t = run_singlepass(clips, out, 30, "h264", 19, hw_concat=hw)
    r = check(out, clips, 30, {paths[1]: 1, paths[2]: 2}) if t["returncode"] == 0 else {}
    r["timing"] = t
    # the same edit clip by clip, for the GPU memory comparison
    with MemSampler() as m:
        tc = export(clips, os.path.join(OUT, name + "_clipbyclip.mp4"), 30, "h264", 19,
                    os.path.join(OUT, name + "_work"))
    tc.update({"gpu_mem_before_mib": m.before, "gpu_mem_peak_mib": m.peak,
               "gpu_mem_delta_mib": m.peak - m.before})
    r["clip_by_clip_timing"] = tc
    json.dump(r, open(os.path.join(OUT, name + "_final.json"), "w"), indent=1, default=str)
    keys = ("decoded_frames", "expected_frames", "marker_mismatches", "cuts_ok", "pts_regular",
            "dts_strictly_increasing", "beeps", "timing", "clip_by_clip_timing")
    print(json.dumps({k: r[k] for k in keys if k in r}, default=str, indent=1))
