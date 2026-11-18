"""Build the text sent to `claude -p` on standard input (spec 3.5.8 request).

One utterance per line: number, start time, pause after, text (tab-separated),
under a short header. Input is a Transcript in the spec 3.4 shape (JSON).

Usage:  python build_request.py data/transcript-150.json > recorded/request-150.txt
"""
import json
import sys

MICRO = 1_000_000


def fmt_time(us):
    s = us / MICRO
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = s - h * 3600 - m * 60
    return f"{h}:{m:02d}:{sec:04.1f}"


def utterance_text(u):
    # Pause and unrecognised tokens carry no words; the pause after the line is
    # reported in its own column instead.
    return " ".join(t["text"] for t in u["tokens"] if t.get("kind") == "word")


def build_request(transcript):
    utts = transcript["utterances"]
    lines = [
        f"Transcript to review: {len(utts)} utterances.",
        "Each line is tab-separated: utterance number, start time (h:mm:ss.s), "
        "pause after the utterance in seconds, text.",
        "",
    ]
    for i, u in enumerate(utts):
        nxt = utts[i + 1]["start"] if i + 1 < len(utts) else u["end"]
        pause = max(0, nxt - u["end"]) / MICRO
        text = " ".join(utterance_text(u).split())  # one line, single spaces
        lines.append(f"{u['index']}\t{fmt_time(u['start'])}\t{pause:.1f}\t{text}")
    return "\n".join(lines) + "\n"


def main():
    transcript = json.loads(open(sys.argv[1], encoding="utf-8").read())
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stdout.write(build_request(transcript))


if __name__ == "__main__":
    main()
