"""Player spike: turn raw results/*.json into the numbers in RESULT.md.

  python analyze.py [tag-prefix ...]      (default: every result file)

Prints markdown tables. Definitions:
  transition  time from the first sample showing the outgoing clip's LAST frame to the first sample
              showing the incoming clip's FIRST frame. Ideal = one frame duration at the playback rate
              (33.3 ms at 1x, 22.2 at 1.5x, 16.7 at 2x); samples are taken once per display refresh,
              so every value is quantised to the refresh interval.
  extra       transition minus the ideal. 0 = seamless; +1 refresh = last frame held one refresh long.
  in-hold     how long the incoming first frame stays before the next frame (start-up of play()).
  wrong       a sample showing a frame that is not in the sequence, or out of sequence order.
  unreadable  marker did not decode (blend, black or not-yet-decoded frame).
  audio dip   total time the continuous tone is below 1/3 of its level within -50..+250 ms of a cut.
"""
import glob, json, os, statistics as st, sys

HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.join(HERE, "results")


def runs(samples):
    out = []
    for t, cur, f in samples:
        if out and out[-1]["f"] == f:
            out[-1]["t1"] = t; out[-1]["n"] += 1
        else:
            out.append({"f": f, "t0": t, "t1": t, "n": 1, "el": cur})
    return out


def seq_index(clips):
    pos, m = 0, {}
    for ci, (a, b) in enumerate(clips):
        for f in range(a, b):
            m[f] = (ci, pos); pos += 1
    return m, pos


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))] if xs else None


def analyze_sequence(d):
    clips, rate, fps = d["clips"], d["rate"], d["fps"]
    ideal = 1000 / fps / rate
    m, total = seq_index(clips)
    rs = runs(d["samples"])
    deltas = [b[0] - a[0] for a, b in zip(d["samples"], d["samples"][1:])]
    refresh = st.median(deltas) if deltas else None
    # Trim before the first frame of the sequence and after the last.
    first = next(i for i, r in enumerate(rs) if r["f"] in m)
    last = max(i for i, r in enumerate(rs) if r["f"] == clips[-1][1] - 1)
    rs = rs[first:last + 1]
    wrong, unreadable, maxpos, shown = 0, 0, -1, set()
    for r in rs:
        if r["f"] < 0:
            unreadable += r["n"]; continue
        if r["f"] not in m or m[r["f"]][1] < maxpos:
            wrong += r["n"]; r["wrong"] = True; continue
        maxpos = m[r["f"]][1]; shown.add(r["f"])
    skipped = total - len(shown)
    # Per cut.
    first_t = {}
    for i, r in enumerate(rs):
        first_t.setdefault(r["f"], i)
    cuts = []
    for k in range(len(clips) - 1):
        L, F = clips[k][1] - 1, clips[k + 1][0]
        iF = first_t.get(F)
        # last displayed frame of clip k (normally L)
        cand = [i for i, r in enumerate(rs) if r["f"] in m and m[r["f"]][0] == k and (iF is None or i < iF)]
        if iF is None or not cand:
            cuts.append({"k": k, "missing": True}); continue
        iL = cand[-1]
        between = [r for r in rs[iL + 1:iF]]
        trans = rs[iF]["t0"] - rs[iL]["t0"]
        hold = rs[iF + 1]["t0"] - rs[iF]["t0"] if iF + 1 < len(rs) else None
        cuts.append({"k": k, "lastShown": rs[iL]["f"] == L, "transition": trans, "extra": trans - ideal,
                     "inHold": hold, "between": [r["f"] for r in between],
                     "backwards": clips[k + 1][0] < clips[k][0], "shortClip": (clips[k + 1][1] - clips[k + 1][0]) < fps})
    ok = [c for c in cuts if not c.get("missing")]
    # In-clip pacing baseline: run lengths of frames that are not at a cut edge.
    edges = {a for a, b in clips} | {b - 1 for a, b in clips}
    inner = [rs[i + 1]["t0"] - r["t0"] for i, r in enumerate(rs[:-1]) if r["f"] >= 0 and r["f"] not in edges and not r.get("wrong")]
    stalls = [e for e in d["events"] if e["name"] == "stallEnd"]
    res = {
        "rate": rate, "ideal_ms": round(ideal, 1), "refresh_ms": round(refresh, 2) if refresh else None,
        "cuts": len(cuts), "cuts_measured": len(ok),
        "extra_ms_median": round(st.median([c["extra"] for c in ok]), 1),
        "extra_ms_max": round(max(c["extra"] for c in ok), 1),
        "extra_ms_min": round(min(c["extra"] for c in ok), 1),
        "cuts_extra_over_half_frame": sum(1 for c in ok if c["extra"] > ideal / 2),
        "in_hold_ms_median": round(st.median([c["inHold"] for c in ok if c["inHold"]]), 1),
        "in_hold_ms_max": round(max(c["inHold"] for c in ok if c["inHold"]), 1),
        "inner_frame_ms_median": round(st.median(inner), 1), "inner_frame_ms_p95": round(pct(inner, 95), 1),
        "inner_frame_ms_max": round(max(inner), 1),
        "wrong_samples": wrong, "unreadable_samples": unreadable, "frames_never_shown": skipped,
        "cuts_with_frame_between": sum(1 for c in ok if c["between"]),
        "stalls": len(stalls), "stall_ms": [round(e["ms"], 1) for e in stalls],
    }
    res["audio"] = analyze_audio(d)
    res["worst_cuts"] = sorted(ok, key=lambda c: -c["extra"])[:4]
    return res


def analyze_audio(d):
    a = d["audio"]
    sr = a["sampleRate"]
    blocks = []
    for b in a["batches"]:
        for i, v in enumerate(b["rms"]):
            blocks.append(((b["frame0"] + i * 128) / sr, v))
    if not blocks:
        return {"error": "no audio blocks recorded"}
    blocks.sort()
    level = pct([v for _, v in blocks], 90)      # the tone's steady level (test media: amplitude 1/16)
    if level < 0.005:
        return {"error": f"no tone heard (median rms {level:.3f})"}
    thr = level / 3
    q = 128 / sr * 1000
    lows, cur = [], None
    for t, v in blocks:
        if v < thr:
            if cur is None: cur = [t, t]
            cur[1] = t
        elif cur is not None:
            lows.append(cur); cur = None
    heard = [t for t, v in blocks if v >= thr]
    start, end = heard[0], heard[-1]
    lows = [(a0, a1 + q / 1000) for a0, a1 in lows if a0 > start and a1 < end]
    swaps = [e["ctxTime"] for e in d["events"] if e["name"] == "swap"]
    dips, used = [], set()
    for s in swaps:
        tot = 0
        for i, (a0, a1) in enumerate(lows):
            if a1 >= s - 0.05 and a0 <= s + 0.25:
                tot += (a1 - a0) * 1000; used.add(i)
        dips.append(tot)
    other = [(a1 - a0) * 1000 for i, (a0, a1) in enumerate(lows) if i not in used]
    return {"tone_rms": round(level, 3), "cuts": len(swaps),
            "dip_ms_median": round(st.median(dips), 1) if dips else None,
            "dip_ms_max": round(max(dips), 1) if dips else None,
            "cuts_without_dip": sum(1 for x in dips if x == 0),
            "dropouts_away_from_cuts": len(other), "dropout_ms_away_max": round(max(other), 1) if other else 0}


def analyze_steps(d):
    s = d["steps"]
    return {"steps": len(s), "correct": sum(1 for x in s if x["got"] == x["want"]),
            "ms_median": round(st.median(x["ms"] for x in s), 1), "ms_max": max(x["ms"] for x in s),
            "wrong": [x for x in s if x["got"] != x["want"]][:5]}


def analyze_shuttle(d):
    m, _ = seq_index(d["clips"])
    rs = [r for r in runs(d["samples"])]
    bad = sum(r["n"] for r in rs if r["f"] < 0 or r["f"] not in m)
    pos = [m[r["f"]][1] for r in rs if r["f"] in m]
    forward = sum(1 for a, b in zip(pos, pos[1:]) if b > a)
    span = (rs[-1]["t0"] - rs[0]["t0"]) / 1000 if len(rs) > 1 else 1
    return {"rate": d["rate"], "seconds": d["seconds"], "distinct_frames": len(rs),
            "frames_per_s": round(len(rs) / span, 1), "seq_frames_covered": pos[0] - pos[-1] if pos else 0,
            "unreadable_or_wrong_samples": bad, "forward_jumps": forward}


def analyze_seek(d):
    if d.get("error"):
        return {"file": d["file"], "canPlayType": d["canPlayType"], "mediaCapabilities": d.get("mediaCapabilities"), "error": d["error"]}
    sk = [x for x in d["seeks"] if x["frameMs"] is not None]
    fm = [x["frameMs"] for x in sk]
    return {"file": d["file"], "canPlayType": d["canPlayType"], "mediaCapabilities": d.get("mediaCapabilities"),
            "loadeddata_ms": d["loadeddataMs"],
            "seek_ms_median": round(st.median(fm), 1), "seek_ms_p90": round(pct(fm, 90), 1), "seek_ms_max": round(max(fm), 1),
            "seeks_correct": f'{sum(1 for x in d["seeks"] if x["marker"] == x["frame"])}/{len(d["seeks"])}',
            "scrub_distinct_frames_per_s": round(d["scrub"]["distinctFrames"] / d["scrub"]["seconds"], 1),
            "play": d["play"]}


def main():
    prefixes = sys.argv[1:] or [""]
    out = {}
    for path in sorted(glob.glob(os.path.join(R, "*.json"))):
        name = os.path.basename(path)[:-5]
        if not any(name.startswith(p) for p in prefixes) or name.endswith("_done"):
            continue
        d = json.load(open(path))
        fn = {"sequence": analyze_sequence, "steps": analyze_steps, "shuttle": analyze_shuttle,
              "seekfile": analyze_seek}.get(d.get("kind"))
        if fn:
            try:
                out[name] = fn(d)
            except Exception as e:
                out[name] = {"error": repr(e)}
    for k, v in out.items():
        print(f"## {k}\n{json.dumps(v, indent=1)}\n")
    json.dump(out, open(os.path.join(R, "summary.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
