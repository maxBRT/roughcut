"""Exactness checks for an exported file made from the numbered sources."""
import json
import math
from fractions import Fraction

from common import beep_onsets, frame_pts, packets, probe, read_markers, read_pcm

RATE = 48000


def expected_markers_cfr(clips, sid_of):
    exp = []
    for src, s, n in clips:
        exp += [(sid_of[src], s + j) for j in range(n)]
    return exp


def expected_markers_fps_rule(clips, sid_of, fps):
    """What ffmpeg's fps filter (round=near) shows: slot p gets the last frame whose rounded pts <= p."""
    cache, exp = {}, []
    for src, s, n in clips:
        if src not in cache:
            fr = frame_pts(src)
            cache[src] = [math.floor(Fraction(f["best_effort_timestamp_time"]) * Fraction(fps) + Fraction(1, 2))
                          for f in fr]
        r = cache[src]
        for p in range(s, s + n):
            i = max(i for i, v in enumerate(r) if v <= p)
            exp.append((sid_of[src], i))
    return exp


def expected_beeps(clips, fps, period_offset, beep_s=0.05):
    """Beeps (beep_s long) at source times k + period_offset seconds. Returns output sample positions
    of beeps that fit fully inside a clip, plus those cut by a clip edge (partial). Output clip
    starts follow export.sample_edges (cumulative frames, floored to samples); a clip's audio is read
    from source time start_frame / fps."""
    from export import sample_edges
    fps = Fraction(fps)
    edges = sample_edges(clips, fps)
    blen = int(beep_s * RATE)
    full, partial = [], []
    for i, (src, s, n) in enumerate(clips):
        o = edges[i]
        a = Fraction(s) / fps * RATE              # source sample where the clip's audio starts
        b = a + (edges[i + 1] - edges[i])
        k = math.floor(a / RATE - Fraction(period_offset).limit_denominator()) - 1
        while True:
            bt = (k + Fraction(period_offset).limit_denominator()) * RATE
            if bt >= b:
                break
            rel = int(round(bt - a))
            if bt >= a and bt + blen <= b:
                full.append(o + rel)
            elif bt < a < bt + blen:
                partial.append(o)
            elif a <= bt < b:
                partial.append(o + rel)
            k += 1
    return full, partial


def check(path, clips, fps, sid_of, vfr=False):
    res = {}
    info = probe(path)
    v = next(s for s in info["streams"] if s["codec_type"] == "video")
    auds = [s for s in info["streams"] if s["codec_type"] == "audio"]
    fps = Fraction(fps)
    total = sum(n for _, _, n in clips)
    res["expected_frames"] = total
    res["expected_seconds"] = float(total / fps)
    res["video"] = {k: v.get(k) for k in ("codec_name", "profile", "pix_fmt", "color_range",
                                          "color_space", "color_transfer", "color_primaries",
                                          "r_frame_rate", "avg_frame_rate", "nb_frames",
                                          "duration", "start_time", "time_base")}
    res["format_duration"] = info["format"]["duration"]
    res["audio"] = [{k: a.get(k) for k in ("codec_name", "channels", "sample_rate", "duration",
                                           "start_time", "nb_frames")} for a in auds]
    # 1. markers
    got = read_markers(path)
    exp = expected_markers_fps_rule(clips, sid_of, fps) if vfr else expected_markers_cfr(clips, sid_of)
    mism = [(i, exp[i] if i < len(exp) else None, got[i] if i < len(got) else None)
            for i in range(max(len(exp), len(got)))
            if (exp[i] if i < len(exp) else None) != (got[i] if i < len(got) else None)]
    res["decoded_frames"] = len(got)
    res["marker_mismatches"] = len(mism)
    res["marker_mismatch_examples"] = mism[:10]
    # cut boundaries
    cuts, o = [], 0
    for src, s, n in clips:
        cuts.append({"out_frame": o, "first": got[o] if o < len(got) else None,
                     "expected_first": exp[o] if o < len(exp) else None,
                     "prev_last": got[o - 1] if o else None,
                     "expected_prev_last": exp[o - 1] if o else None})
        o += n
    res["cuts_ok"] = all(c["first"] == c["expected_first"] and c["prev_last"] == c["expected_prev_last"]
                         for c in cuts)
    # 2. packet timestamps of the video track
    pk = packets(path)
    pts = sorted(int(p["pts"]) for p in pk)
    dts = [int(p["dts"]) for p in pk]
    durs = set(int(p["duration"]) for p in pk)
    step = pts[1] - pts[0]
    res["video_packets"] = len(pk)
    res["pts_regular"] = all(pts[i] == pts[0] + i * step for i in range(len(pts)))
    res["pts_first_last"] = (pts[0], pts[-1], step)
    res["dts_strictly_increasing"] = all(dts[i] < dts[i + 1] for i in range(len(dts) - 1))
    res["packet_durations"] = sorted(durs)
    res["keyframes_at"] = [i for i, p in enumerate(sorted(pk, key=lambda p: int(p["pts"])))
                           if "K" in p["flags"]]
    # 3. audio: per track length and beeps
    res["beeps"] = []
    for t, off in ((0, 0.0), (1, 0.5)):
        if t >= len(auds):
            break
        x = read_pcm(path, f"a:{t}")
        full, partial = expected_beeps(clips, fps, off)
        det = beep_onsets(x, RATE, thr=0.1, min_gap=0.02)
        errs, unmatched = [], []
        for e in full:
            d = min(det, key=lambda q: abs(q - e)) if det else None
            if d is None or abs(d - e) > RATE * 0.02:
                unmatched.append(e)
            else:
                errs.append((d - e) / RATE * 1000)
        allowed = set(full) | set(partial)
        extra = [d for d in det if min(abs(d - a) for a in allowed) > RATE * 0.02]
        res["beeps"].append({
            "track": t + 1, "samples": len(x), "seconds": len(x) / RATE,
            "length_minus_video_ms": (len(x) / RATE - float(total / fps)) * 1000,
            "expected_full_beeps": len(full), "matched": len(errs), "unmatched": len(unmatched),
            "extra_onsets": len(extra),
            "max_abs_err_ms": max((abs(e) for e in errs), default=None),
            "mean_err_ms": sum(errs) / len(errs) if errs else None,
            "last_beep_err_ms": errs[-1] if errs else None})
    return res


if __name__ == "__main__":
    import sys
    print(json.dumps(probe(sys.argv[1]), indent=1))
