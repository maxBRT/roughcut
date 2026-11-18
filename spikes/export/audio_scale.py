"""Audio render at real clip counts.

export.audio_cmd puts one input per clip on the command line. Windows limits a command line to
32,767 characters, which that form passes at roughly 50 clips (two tracks, long paths), and an edit
made from a transcript easily has hundreds. This script checks the form that has no such limit:
the whole filter graph goes in a script file (ffmpeg 7+ reads an option's value from a file when
the option is written "-/filter_complex <file>"), and every clip reads its source through an
"amovie" source filter inside that graph, so nothing grows on the command line.

python audio_scale.py            12-clip edit (exactness check) and a 400-clip edit (scale)
Results: .cache-dev/export/audio/audio_scale.json
"""
import json
import os
import subprocess
import threading
import time
from fractions import Fraction

from common import FFMPEG, MEDIA, beep_onsets, read_pcm, run
from export import AUDIO_RATE, audio_cmd, audio_script, audio_script_cmd, sample_edges
from run_exactness import EDIT, S
from verify import expected_beeps

OUT = os.path.join(MEDIA, "audio")
os.makedirs(OUT, exist_ok=True)


def script_cmd(script, n_tracks, out):
    return audio_script_cmd(script, n_tracks, out)


class PeakRss:
    """Peak working set of the newest ffmpeg.exe process, polled with tasklist."""
    def __enter__(self):
        self.peak_kb = 0
        self.stop = threading.Event()
        self.t = threading.Thread(target=self._loop, daemon=True)
        self.t.start()
        return self

    def _loop(self):
        while not self.stop.wait(0.2):
            try:
                p = subprocess.run(["tasklist", "/FI", "IMAGENAME eq ffmpeg.exe", "/FO", "CSV", "/NH"],
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
                for line in p.stdout.decode(errors="replace").splitlines():
                    parts = [x.strip('"') for x in line.split('","')]
                    if len(parts) >= 5:
                        kb = int(parts[4].replace(",", "").replace(".", "").split()[0])
                        self.peak_kb = max(self.peak_kb, kb)
            except Exception:  # noqa
                pass

    def __exit__(self, *a):
        self.stop.set()
        self.t.join()


def check_audio(path, clips, fps, n_tracks):
    fps = Fraction(fps)
    edges = sample_edges(clips, fps)
    res = []
    for t, off in zip(range(n_tracks), (0.0, 0.5)):
        x = read_pcm(path, f"a:{t}")
        full, partial = expected_beeps(clips, fps, off)
        det = beep_onsets(x, AUDIO_RATE, thr=0.1, min_gap=0.02)
        errs = []
        for e in full:
            d = min(det, key=lambda q: abs(q - e)) if det else None
            if d is not None and abs(d - e) <= AUDIO_RATE * 0.02:
                errs.append((d - e) / AUDIO_RATE * 1000)
        allowed = set(full) | set(partial)
        extra = [d for d in det if not allowed or min(abs(d - a) for a in allowed) > AUDIO_RATE * 0.02]
        res.append({"track": t + 1, "samples": len(x), "expected_samples": edges[-1],
                    "expected_full_beeps": len(full), "matched": len(errs), "extra_onsets": len(extra),
                    "max_abs_err_ms": max((abs(e) for e in errs), default=None)})
    return res


def one(name, clips, fps, layouts, with_cmdline_form):
    r = {"clips": len(clips), "frames": sum(c[2] for c in clips)}
    if with_cmdline_form:
        cmd = audio_cmd(clips, fps, len(layouts), os.path.join(OUT, name + "_cmdline.nut"), layouts)
        r["cmdline_form_chars"] = len(subprocess.list2cmdline(cmd))
    script = os.path.join(OUT, name + ".filtergraph.txt")
    with open(script, "w", encoding="utf-8", newline="\n") as f:
        f.write(audio_script(clips, fps, layouts))
    out = os.path.join(OUT, name + ".nut")
    cmd = script_cmd(script, len(layouts), out)
    r["script_form_chars"] = len(subprocess.list2cmdline(cmd))
    r["script_bytes"] = os.path.getsize(script)
    t0 = time.perf_counter()
    with PeakRss() as m:
        dt, p = run(cmd, label=f"audio script {name}", check=False)
    r["seconds"] = round(dt, 2)
    r["peak_working_set_mb"] = round(m.peak_kb / 1024, 1)
    r["returncode"] = p.returncode
    if p.returncode != 0:
        r["stderr_tail"] = p.stderr.decode(errors="replace")[-1500:]
        return r
    r["tracks"] = check_audio(out, clips, fps, len(layouts))
    r["ok"] = all(t["samples"] == t["expected_samples"] and t["matched"] == t["expected_full_beeps"]
                  and t["extra_onsets"] == 0 for t in r["tracks"])
    os.remove(out)
    return r


def main():
    paths = {1: os.path.join(S, "A1.mp4"), 2: os.path.join(S, "A2.mp4")}
    layouts = ["stereo", "mono"]
    res = {}
    clips12 = [(paths[k], s, n) for k, s, n in EDIT]
    res["edit12"] = one("edit12", clips12, 30, layouts, True)
    print("edit12", res["edit12"], flush=True)
    # 400 clips of 3 to 20 frames, out of order, alternating sources: about 4 minutes of output
    clips400 = [(paths[1 + i % 2], (i * 389) % 1750 + 3, 3 + (i * 7) % 18) for i in range(400)]
    res["edit400"] = one("edit400", clips400, 30, layouts, True)
    print("edit400", res["edit400"], flush=True)
    json.dump(res, open(os.path.join(OUT, "audio_scale.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
