"""Score Claude's suggestions against the planted ground truth.

Usage: python score.py <transcript.json> <ground-truth.json> <recorded stdout file>

The stdout file is either the plain JSON envelope (an object with
`structured_output`) or the --verbose array whose last element is that envelope.

For each suggestion it checks that `quote` can be located inside utterances
first_utterance..last_utterance, the way the app will (spec 3.5.8):
  exact      - the quote occurs verbatim in the utterances' text joined by single spaces
  normalised - it occurs after lower-casing and dropping punctuation (word sequence match)
  missing    - neither; the app would drop this suggestion
Then it matches suggestions to planted items by located word ranges:
  found      - overlaps a planted item of the same kind
  found_kind - overlaps a planted item, different kind
  wrong      - overlaps no planted item
  missed     - planted item no suggestion overlaps
Extent quality = intersection-over-union of the cut words vs the planted words.
"""
import json
import re
import sys

PUNCT = re.compile(r"[^\w']+")


def norm_words(text):
    return [w for w in (PUNCT.sub(" ", text.lower().replace("’", "'")).split()) if w]


def load_envelope(path):
    data = json.loads(open(path, encoding="utf-8").read())
    if isinstance(data, list):
        data = [m for m in data if m.get("type") == "result"][-1]
    return data


def build_index(transcript):
    """Global word list (normalised) and each utterance's [start, end) word span."""
    words, spans, raw = [], {}, {}
    for u in transcript["utterances"]:
        text = " ".join(t["text"] for t in u["tokens"] if t.get("kind") == "word")
        raw[u["index"]] = text
        w = norm_words(text)
        spans[u["index"]] = (len(words), len(words) + len(w))
        words.extend(w)
    return words, spans, raw


def locate(quote, first, last, words, spans, raw):
    if first not in spans or last not in spans or last < first:
        return "bad_range", None
    joined = " ".join(raw[i] for i in range(first, last + 1))
    status = "exact" if quote in joined else None
    q = norm_words(quote)
    lo, hi = spans[first][0], spans[last][1]
    for s in range(lo, hi - len(q) + 1):
        if words[s:s + len(q)] == q:
            return status or "normalised", (s, s + len(q))
    return "missing", None


def main():
    transcript = json.loads(open(sys.argv[1], encoding="utf-8").read())
    truth = json.loads(open(sys.argv[2], encoding="utf-8").read())
    env = load_envelope(sys.argv[3])
    sugg = (env.get("structured_output") or {}).get("suggestions")
    if sugg is None:
        print("no structured_output in envelope:", env.get("result"))
        sys.exit(1)
    words, spans, raw = build_index(transcript)

    loc_counts = {}
    located = []
    for s in sugg:
        st, rng = locate(s["quote"], s["first_utterance"], s["last_utterance"], words, spans, raw)
        loc_counts[st] = loc_counts.get(st, 0) + 1
        if st in ("missing", "bad_range"):
            print(f"  UNLOCATED [{st}] #{s['first_utterance']}-{s['last_utterance']} {s['kind']}: {s['quote'][:90]!r}")
        located.append((s, rng))

    gt_ranges = []
    for g in truth:
        st, rng = locate(g["quote"], g["first_utterance"], g["last_utterance"], words, spans, raw)
        assert rng, f"ground truth quote not found: {g}"
        gt_ranges.append((g, rng))

    def overlap(a, b):
        return max(0, min(a[1], b[1]) - max(a[0], b[0]))

    found = found_kind = wrong = 0
    ious = []
    keep_ok = keep_total = 0
    matched_gt = set()
    for s, rng in located:
        if rng is None:
            # fall back to utterance overlap so an unlocatable quote is still classified
            rng = (spans[s["first_utterance"]][0], spans[s["last_utterance"]][1]) if s["first_utterance"] in spans and s["last_utterance"] in spans else (0, 0)
        hits = [(i, g, r) for i, (g, r) in enumerate(gt_ranges) if overlap(rng, r) > 0]
        if not hits:
            wrong += 1
            print(f"  WRONG #{s['first_utterance']}-{s['last_utterance']} {s['kind']}: {s['quote'][:90]!r} -- {s['reason']}")
            continue
        i, g, r = max(hits, key=lambda h: overlap(rng, h[2]))
        matched_gt.add(i)
        iou = overlap(rng, r) / (max(rng[1], r[1]) - min(rng[0], r[0]))
        ious.append(iou)
        if g["kind"] == s["kind"]:
            found += 1
        else:
            found_kind += 1
            print(f"  KIND #{s['first_utterance']}-{s['last_utterance']}: said {s['kind']}, planted {g['kind']}")
        if iou < 0.999:
            print(f"  EXTENT #{s['first_utterance']}-{s['last_utterance']} IoU {iou:.2f}: cut {s['quote'][:70]!r} vs planted {g['quote'][:70]!r}")
        if "keep_utterance" in g:
            keep_total += 1
            if s.get("keep_utterance") == g["keep_utterance"]:
                keep_ok += 1
            else:
                print(f"  KEEP #{s['first_utterance']}: said {s.get('keep_utterance')}, planted {g['keep_utterance']}")
    missed = [g for i, (g, r) in enumerate(gt_ranges) if i not in matched_gt]
    for g in missed:
        print(f"  MISSED #{g['first_utterance']}-{g['last_utterance']} {g['kind']}: {g['quote'][:90]!r}")

    by_kind = {}
    for i, (g, r) in enumerate(gt_ranges):
        k = by_kind.setdefault(g["kind"], [0, 0])
        k[1] += 1
        if i in matched_gt:
            k[0] += 1
    summary = dict(
        suggestions=len(sugg), planted=len(truth),
        planted_found=len(matched_gt), recall=round(len(matched_gt) / len(truth), 3),
        suggestions_found_same_kind=found, suggestions_found_other_kind=found_kind,
        suggestions_wrong=wrong, precision=round((found + found_kind) / max(1, len(sugg)), 3),
        found_by_kind={k: f"{v[0]}/{v[1]}" for k, v in by_kind.items()},
        quote_location=loc_counts,
        mean_extent_iou=round(sum(ious) / max(1, len(ious)), 3),
        exact_extent=sum(1 for x in ious if x >= 0.999),
        keep_utterance_correct=f"{keep_ok}/{keep_total}",
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
