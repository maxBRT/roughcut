"""Shared helpers for the export spike. Every media operation is an ffmpeg/ffprobe command line."""
import json
import os
import shutil
import subprocess
import time
from fractions import Fraction

ROOT = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(ROOT, "..", ".."))
MEDIA = os.path.join(PROJECT, ".cache-dev", "export")
os.makedirs(MEDIA, exist_ok=True)

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"

LOG = os.path.join(MEDIA, "commands.log")


def q(a):
    a = str(a)
    return '"' + a + '"' if (" " in a or ";" in a or "|" in a or "[" in a) else a


def run(args, label=None, capture=False, check=True):
    """Run a command, log it, return (seconds, CompletedProcess)."""
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(f"# {label or ''}\n" + " ".join(q(a) for a in args) + "\n")
    t0 = time.perf_counter()
    p = subprocess.run(args, stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                       stderr=subprocess.PIPE)
    dt = time.perf_counter() - t0
    if check and p.returncode != 0:
        raise RuntimeError(f"command failed ({p.returncode}): {' '.join(map(str,args))}\n"
                           + p.stderr.decode(errors="replace")[-4000:])
    return dt, p


def probe(path):
    _, p = run([FFPROBE, "-v", "error", "-print_format", "json", "-show_format",
                "-show_streams", path], capture=True)
    return json.loads(p.stdout)


def packets(path, sel="v:0", entries="packet=pts,dts,duration,flags"):
    _, p = run([FFPROBE, "-v", "error", "-select_streams", sel, "-show_entries", entries,
                "-of", "json", path], capture=True)
    return json.loads(p.stdout)["packets"]


def frame_pts(path, sel="v:0"):
    _, p = run([FFPROBE, "-v", "error", "-select_streams", sel, "-show_entries",
                "frame=pts,best_effort_timestamp_time,duration", "-of", "json", path], capture=True)
    return json.loads(p.stdout)["frames"]


MARK_BITS = 16      # bits 0-11 frame number, bits 12-15 source id
MARK_H = 160        # marker band height in a 2160-line frame


def read_markers(path, extra_in=()):
    """Decode the binary block marker of every frame. Returns list of (source_id, frame_no)."""
    _, p = run([FFMPEG, "-v", "error", *extra_in, "-i", path, "-map", "0:v:0",
                "-vf", f"crop=iw:{MARK_H}*ih/2160:0:0,scale={MARK_BITS}:1:flags=area,format=gray",
                "-fps_mode", "passthrough", "-f", "rawvideo", "-"], capture=True)
    b = p.stdout
    out = []
    for i in range(0, len(b) - MARK_BITS + 1, MARK_BITS):
        v = 0
        for bit in range(MARK_BITS):
            if b[i + bit] > 128:
                v |= 1 << bit
        out.append((v >> 12, v & 0xFFF))
    return out


def read_pcm(path, stream="a:0", rate=48000):
    """Decode one audio stream to mono float32 numpy array (first channel)."""
    import numpy as np
    _, p = run([FFMPEG, "-v", "error", "-i", path, "-map", f"0:{stream}", "-ac", "1",
                "-ar", str(rate), "-f", "f32le", "-"], capture=True)
    return np.frombuffer(p.stdout, dtype=np.float32)


def beep_onsets(x, rate=48000, thr=0.1, min_gap=0.2):
    """Sample index of each beep onset (first sample above thr after >= min_gap s of quiet)."""
    import numpy as np
    loud = np.flatnonzero(np.abs(x) > thr)
    if len(loud) == 0:
        return []
    ons = [loud[0]]
    gaps = np.diff(loud)
    for i in np.flatnonzero(gaps > min_gap * rate):
        ons.append(loud[i + 1])
    return ons


def gpu_state():
    try:
        p = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu,utilization.encoder,"
                            "utilization.decoder,memory.used", "--format=csv,noheader"],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
        return p.stdout.decode().strip()
    except Exception as e:  # noqa
        return f"nvidia-smi failed: {e}"


def frac(s):
    return Fraction(s)
