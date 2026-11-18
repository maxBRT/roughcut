"""Scores recorded transcriber output against the known script / AMI reference.

Usage: python analyze.py <recordedDir> <amiWordsXml> [amiOffsetSeconds=300] [amiLength=300]
Prints a summary per run and writes <recordedDir>/analysis.json.
"""
import json, re, sys, statistics, glob, os, difflib

NUM = {"20": "twenty", "40": "forty", "40-minute": "forty minute", "20-minute": "twenty minute", "40minute": "forty minute"}
FILLERS = {"uh", "um", "mm", "hmm", "mm-hmm", "uh-huh", "ah", "er", "erm", "eh"}


def norm_words(text):
    out = []
    for w in text.lower().replace("’", "'").split():
        w = w.strip(".,?!;:\"()")
        if not w:
            continue
        w = NUM.get(w, w)
        out.extend(w.split())
    return out


def align(ref, hyp):
    """Levenshtein alignment; returns (errors, pairs[(ri|None, hi|None)])."""
    n, m = len(ref), len(hyp)
    d = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        d[i][0] = i
    for j in range(m + 1):
        d[0][j] = j
    for i in range(1, n + 1):
        ri = ref[i - 1]
        row, prev = d[i], d[i - 1]
        for j in range(1, m + 1):
            row[j] = min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (ri != hyp[j - 1]))
    i, j, pairs = n, m, []
    while i > 0 or j > 0:
        if i > 0 and j > 0 and d[i][j] == d[i - 1][j - 1] + (ref[i - 1] != hyp[j - 1]):
            pairs.append((i - 1, j - 1)); i -= 1; j -= 1
        elif i > 0 and d[i][j] == d[i - 1][j] + 1:
            pairs.append((i - 1, None)); i -= 1
        else:
            pairs.append((None, j - 1)); j -= 1
    return d[n][m], pairs[::-1]


def load_run(path):
    segs, words, swow, speech, stats, ready = [], [], [], [], {}, {}
    for line in open(path, encoding="utf-8"):
        m = json.loads(line)
        t = m["type"]
        if t == "segment":
            segs.append(m)
            for w in m["words"]:
                for k, nw in enumerate(norm_words(w["text"])):
                    words.append({"w": nw, "start": w["start"], "end": w["end"], "raw": w["text"]})
        elif t == "speech_without_words":
            swow.append(m)
        elif t == "done":
            speech, stats = m["speech"], m.get("stats", {})
        elif t == "ready":
            ready = m
    return segs, words, swow, speech, stats, ready


def stat(xs):
    if not xs:
        return None
    a = [abs(x) for x in xs]
    return {"n": len(xs), "mean": round(statistics.mean(xs), 3), "mean_abs": round(statistics.mean(a), 3),
            "median": round(statistics.median(xs), 3), "max_abs": round(max(a), 3)}


def score_monologue(path, truth):
    segs, words, swow, speech, stats, ready = load_run(path)
    lines = truth["lines"]
    per_line = []
    used = set()
    for k, L in enumerate(lines):
        nxt = lines[k + 1]["start"] if k + 1 < len(lines) else truth["duration"]
        lo, hi = L["start"] - 0.6, min(L["end"] + 0.6, nxt - 0.05)
        idx = [i for i, w in enumerate(words) if lo <= (w["start"] + w["end"]) / 2 <= hi]
        used.update(idx)
        hw = [words[i] for i in idx]
        ref = norm_words(L["text"])
        hyp = [w["w"] for w in hw]
        err, pairs = align(ref, hyp)
        rec = {"index": k, "kind": L["kind"], "ref": " ".join(ref), "hyp": " ".join(hyp),
               "errors": err, "ref_words": len(ref)}
        if hw:
            rec["start_err"] = round(hw[0]["start"] - L["start"], 3)
            rec["end_err"] = round(hw[-1]["end"] - L["end"], 3)
            # word starts vs SAPI positions (approximate truth)
            sapi = [norm_words(x["text"]) for x in L["words_start_approx"]]
            sapi_flat = [(ws[0], x["start"]) for ws, x in zip(sapi, L["words_start_approx"]) if ws]
            sm = difflib.SequenceMatcher(a=[s[0] for s in sapi_flat], b=hyp, autojunk=False)
            diffs = []
            for blk in sm.get_matching_blocks():
                for q in range(blk.size):
                    diffs.append(hw[blk.b + q]["start"] - sapi_flat[blk.a + q][1])
            rec["word_start_diffs"] = [round(x, 3) for x in diffs]
        ref_f = [w for w in ref if w in FILLERS] + ["you know"] * L["text"].lower().count("you know")
        hyp_text = " ".join(hyp)
        rec["fillers_ref"] = ref_f
        # a filler counts as kept if the hypothesis has a filler token there, whatever its spelling (uh/ah/um)
        n_hyp_fill = sum(1 for w in hyp if w in FILLERS)
        kept = [f for f in ref_f if f != "you know"][:n_hyp_fill]
        kept += [f for f in ref_f if f == "you know" and "you know" in hyp_text]
        rec["fillers_kept"] = kept
        rec["hyp_fillers"] = [w for w in hyp if w in FILLERS]
        per_line.append(rec)
    # words outside every line window = text in silence
    silence_words = [words[i] for i in range(len(words)) if i not in used]
    # VAD vs truth
    vad_start, vad_end = [], []
    for L in lines:
        ov = [s for s in speech if s["start"] < L["end"] and s["end"] > L["start"]]
        if ov:
            vad_start.append(ov[0]["start"] - L["start"]); vad_end.append(ov[-1]["end"] - L["end"])
    tot_err = sum(r["errors"] for r in per_line); tot_ref = sum(r["ref_words"] for r in per_line)
    fill_ref = sum(len(r["fillers_ref"]) for r in per_line); fill_kept = sum(len(r["fillers_kept"]) for r in per_line)
    retakes = [r for r in per_line if r["kind"] in ("retake_first", "retake_repeat")]
    abandoned = [r for r in per_line if r["kind"] == "abandoned"]
    long_pause_end = [r["end_err"] for r, L in zip(per_line, lines) if "end_err" in r and L["pause_after"] >= 1.0]
    return {
        "file": os.path.basename(path), "device": ready.get("device"), "stats": stats,
        "wer": round(tot_err / tot_ref, 4), "ref_words": tot_ref,
        "fillers_kept": f"{fill_kept}/{fill_ref}",
        "retake_lines_transcribed": f"{sum(1 for r in retakes if r['hyp'] and r['errors'] <= 2)}/{len(retakes)}",
        "abandoned_lines_transcribed": f"{sum(1 for r in abandoned if r['hyp'])}/{len(abandoned)}",
        "words_in_silence": [w["raw"] + f"@{w['start']}" for w in silence_words],
        "speech_without_words": len(swow),
        "line_start_err": stat([r["start_err"] for r in per_line if "start_err" in r]),
        "line_end_err": stat([r["end_err"] for r in per_line if "end_err" in r]),
        "last_word_end_minus_true_end_before_pause": stat(long_pause_end),
        "word_start_vs_sapi": stat([d for r in per_line for d in r.get("word_start_diffs", [])]),
        "vad_start_minus_true": stat(vad_start), "vad_end_minus_true": stat(vad_end),
        "lines": per_line,
    }


def score_ami(path, xml, off, length):
    t = open(xml, encoding="latin-1").read()
    ref = []
    for a, b, w in re.findall(r'<w [^>]*starttime="([\d.]+)" endtime="([\d.]+)"(?![^>]*punc)[^>]*>([^<]*)</w>', t):
        a, b = float(a), float(b)
        if off <= a < off + length:
            for nw in norm_words(w.replace("&#39;", "'")):
                ref.append({"w": nw, "start": a - off, "end": b - off})
    segs, words, swow, speech, stats, ready = load_run(path)
    err, pairs = align([r["w"] for r in ref], [h["w"] for h in words])
    ds, de, fill_ref, fill_kept = [], [], 0, 0
    sub = ins = dele = 0
    for ri, hi in pairs:
        if ri is None:
            ins += 1
        elif hi is None:
            dele += 1
        elif ref[ri]["w"] != words[hi]["w"]:
            sub += 1
        if ri is not None and ref[ri]["w"] in FILLERS:
            fill_ref += 1
            if hi is not None and words[hi]["w"] in FILLERS:
                fill_kept += 1
        if ri is not None and hi is not None and ref[ri]["w"] == words[hi]["w"]:
            ds.append(words[hi]["start"] - ref[ri]["start"]); de.append(words[hi]["end"] - ref[ri]["end"])
    return {"file": os.path.basename(path), "device": ready.get("device"), "stats": stats,
            "wer": round(err / len(ref), 4), "ref_words": len(ref), "sub": sub, "del": dele, "ins": ins,
            "fillers_kept": f"{fill_kept}/{fill_ref}",
            "hyp_fillers_total": sum(1 for h in words if h["w"] in FILLERS),
            "word_start_err": stat(ds), "word_end_err": stat(de),
            "speech_without_words": len(swow)}


def main():
    rec = sys.argv[1]; xml = sys.argv[2]
    off = float(sys.argv[3]) if len(sys.argv) > 3 else 300.0
    length = float(sys.argv[4]) if len(sys.argv) > 4 else 300.0
    truth = json.load(open(os.path.join(rec, "monologue_truth.json"), encoding="utf-8"))
    res = {"monologue": [], "ami": []}
    for p in sorted(glob.glob(os.path.join(rec, "monologue_*__*.jsonl"))):
        r = score_monologue(p, truth); res["monologue"].append(r)
        print(f"{r['file']:45s} WER {r['wer']:.3f} fillers {r['fillers_kept']} retakes {r['retake_lines_transcribed']} "
              f"abandoned {r['abandoned_lines_transcribed']} silence-words {len(r['words_in_silence'])} {r['words_in_silence'][:6]} "
              f"swow {r['speech_without_words']}\n   start {r['line_start_err']}\n   end {r['line_end_err']}\n   endBeforePause {r['last_word_end_minus_true_end_before_pause']}\n   wordStart~SAPI {r['word_start_vs_sapi']}\n   vadStart {r['vad_start_minus_true']} vadEnd {r['vad_end_minus_true']}")
    for p in sorted(glob.glob(os.path.join(rec, "ami_*__*.jsonl"))):
        r = score_ami(p, xml, off, length); res["ami"].append(r)
        print(f"{r['file']:45s} WER {r['wer']:.3f} (S{r['sub']} D{r['del']} I{r['ins']} of {r['ref_words']}) fillers {r['fillers_kept']} hypFillers {r['hyp_fillers_total']}\n   start {r['word_start_err']}\n   end {r['word_end_err']}")
    json.dump(res, open(os.path.join(rec, "analysis.json"), "w", encoding="utf-8"), indent=1)


main()
