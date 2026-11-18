/**
 * The wording the Transcript view shows, as matched against the mockup: the reason line under a
 * suggestion ("retake · 1 of 3") and the time left while transcribing, which must read the same
 * as the player panel's note.
 */
import { describe, expect, it } from "vitest";
import type { Suggestion } from "../../types";
import { formatTimeLeft } from "../editor/format";
import { formatSecondsLeft } from "./format";
import { suggestionLineText } from "./rowViews";

function suggestion(over: Partial<Suggestion>): Suggestion {
  return {
    id: "s1",
    kind: "retake",
    origin: "claude",
    range: { sourceId: "a", start: 0, end: 1_000_000 },
    reason: "",
    ...over,
  } as Suggestion;
}

describe("suggestion reason line", () => {
  it("is the mockup's 'kind · n of m' when there is no reason", () => {
    expect(suggestionLineText(suggestion({}), 1, 3)).toBe("retake · 1 of 3");
  });

  it("does not repeat the kind when the reason already starts with it, and starts lower-case", () => {
    const s = suggestion({ reason: "Retake, said again at the next paragraph", keptVersionAt: 36_000_000 });
    expect(suggestionLineText(s, 2, 15)).toBe("retake, said again at the next paragraph · kept take at 0:36 · 2 of 15");
  });

  it("keeps the kind in front of a reason that does not name it", () => {
    const s = suggestion({ kind: "dead_air", origin: "local", reason: "Long silence" });
    expect(suggestionLineText(s, 1, 15)).toBe("dead air · long silence · 1 of 15");
    const f = suggestion({ kind: "false_start", reason: "False start before the full sentence" });
    expect(suggestionLineText(f, 0, 0)).toBe("false start before the full sentence");
  });
});

describe("time left while transcribing", () => {
  it("reads exactly like the player panel's note", () => {
    for (const s of [5, 49, 50, 89, 90, 170, 3 * 3600]) expect(formatSecondsLeft(s)).toBe(formatTimeLeft(s));
    expect(formatSecondsLeft(20)).toBe("under a minute left");
    expect(formatSecondsLeft(170)).toBe("about 3 min left");
  });

  it("is empty when the time left is not a number", () => {
    expect(formatSecondsLeft(Number.NaN)).toBe("");
  });
});
