// Review tests (track keys-review). Failing ones are left for the fixer.
import { describe, expect, it } from "vitest";
import { chordFromEvent } from "./chord";
import { createKeymap, resolve } from "./keymap";

describe("review: numeric keypad with Num Lock off", () => {
  // On Windows with Num Lock off the keypad "Del" key reports key "Delete", code "NumpadDecimal".
  it("keypad Del is Delete, not '.'", () => {
    expect(chordFromEvent({ key: "Delete", code: "NumpadDecimal" })).toBe("Delete");
  });

  it("keypad Del removes the clip on the timeline instead of nudging an edge", () => {
    const km = createKeymap();
    expect(resolve(km, { key: "Delete", code: "NumpadDecimal" }, "timeline")).toBe("timeline.removeClip");
    expect(resolve(km, { key: "Delete", code: "NumpadDecimal" }, "transcript")).toBe("transcript.cut");
    expect(resolve(km, { key: "Delete", code: "NumpadDecimal" }, "home")).toBe("home.remove");
  });

  it("with Num Lock on the keypad '.' is still '.'", () => {
    expect(chordFromEvent({ key: ".", code: "NumpadDecimal" })).toBe(".");
  });
});
