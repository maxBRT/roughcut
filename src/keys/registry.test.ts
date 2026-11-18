import { describe, expect, it } from "vitest";
import type { KeyContext } from "../types";
import { KEY_ACTIONS, SCREEN_HINTS, getAction } from "./actions";
import { parseChord } from "./chord";
import { createKeymap, findClashes, scopesOverlap } from "./keymap";

/**
 * The tables of spec 1.10, copied verbatim (key column and action column), with the action ids
 * this registry gives each key group, in order. Plus the Home and Export keys of spec 1.7.
 */
interface Row {
  keys: string;
  action: string;
  ids: string[];
}

const SPEC_TABLES: { context: KeyContext; rows: Row[] }[] = [
  {
    context: "everywhere",
    rows: [
      { keys: "`Space`", action: "Play / pause", ids: ["everywhere.playPause"] },
      {
        keys: "`J` `K` `L`",
        action: "Play backwards / pause / play forwards. Press `L` again to go faster. Backwards is silent",
        ids: ["everywhere.playBackward", "everywhere.pause", "everywhere.playForward"],
      },
      { keys: "`1` `2` `3`", action: "Playback speed 1x / 1.5x / 2x", ids: ["everywhere.speed1x", "everywhere.speed1_5x", "everywhere.speed2x"] },
      { keys: "`Tab`", action: "Switch between Transcript and Timeline", ids: ["everywhere.switchView"] },
      { keys: "`Ctrl+Z` / `Ctrl+Shift+Z`", action: "Undo / redo", ids: ["everywhere.undo", "everywhere.redo"] },
      { keys: "`Ctrl+N`", action: "New project from footage", ids: ["everywhere.newProject"] },
      { keys: "`Ctrl+O`", action: "Add footage to this project", ids: ["everywhere.addFootage"] },
      { keys: "`Ctrl+E`", action: "Export", ids: ["everywhere.export"] },
      { keys: "`Ctrl+F`", action: "Find in transcript", ids: ["everywhere.find"] },
      { keys: "`?`", action: "Show shortcuts", ids: ["everywhere.showShortcuts"] },
      { keys: "`Esc`", action: "Close dialog, clear selection", ids: ["everywhere.escape"] },
    ],
  },
  {
    context: "transcript",
    rows: [
      { keys: "`←` `→`", action: "Move by word", ids: ["transcript.wordPrev", "transcript.wordNext"] },
      { keys: "`↑` `↓`", action: "Move by line", ids: ["transcript.linePrev", "transcript.lineNext"] },
      { keys: "`Ctrl+←` `Ctrl+→`", action: "Move by sentence", ids: ["transcript.sentencePrev", "transcript.sentenceNext"] },
      { keys: "`Ctrl+↑` `Ctrl+↓`", action: "Move by paragraph", ids: ["transcript.paragraphPrev", "transcript.paragraphNext"] },
      {
        keys: "`Shift` + any of the above",
        action: "Extend the selection",
        ids: [
          "transcript.extendWordPrev", "transcript.extendWordNext",
          "transcript.extendLinePrev", "transcript.extendLineNext",
          "transcript.extendSentencePrev", "transcript.extendSentenceNext",
          "transcript.extendParagraphPrev", "transcript.extendParagraphNext",
        ],
      },
      { keys: "`Delete` or `Backspace`", action: "Cut the selection (or the word at the caret)", ids: ["transcript.cut"] },
      { keys: "`R`", action: "Restore the selection", ids: ["transcript.restore"] },
      { keys: "`I` / `O`", action: "Mark the start / end of a range at the playhead", ids: ["transcript.markIn", "transcript.markOut"] },
      { keys: "`Enter`", action: "Play from the caret", ids: ["transcript.playFromCaret"] },
      { keys: "`H`", action: "Hide / show cut text", ids: ["transcript.toggleCutText"] },
      { keys: "`N` / `Shift+N`", action: "Next / previous suggestion", ids: ["transcript.nextSuggestion", "transcript.prevSuggestion"] },
      { keys: "`A` / `D`", action: "Accept (cut) / dismiss (keep) the current suggestion", ids: ["transcript.acceptSuggestion", "transcript.dismissSuggestion"] },
      { keys: "`Shift+A`", action: "Accept all remaining suggestions", ids: ["transcript.acceptAllSuggestions"] },
    ],
  },
  {
    context: "timeline",
    rows: [
      { keys: "`←` `→`", action: "Step one frame", ids: ["timeline.stepFrameBack", "timeline.stepFrameForward"] },
      { keys: "`Shift+←` `Shift+→`", action: "Step one second", ids: ["timeline.stepSecondBack", "timeline.stepSecondForward"] },
      { keys: "`↑` `↓`", action: "Jump to previous / next cut", ids: ["timeline.prevCut", "timeline.nextCut"] },
      {
        keys: "`,` `.`",
        action: "Nudge the end of the clip before the cut, one frame earlier / later",
        ids: ["timeline.nudgeEndEarlier", "timeline.nudgeEndLater"],
      },
      {
        keys: "`Shift+,` `Shift+.`",
        action: "Nudge the start of the clip after the cut, one frame earlier / later",
        ids: ["timeline.nudgeStartEarlier", "timeline.nudgeStartLater"],
      },
      { keys: "`Q` / `W`", action: "Trim the clip's start / end to the playhead", ids: ["timeline.trimStart", "timeline.trimEnd"] },
      { keys: "`S`", action: "Split at the playhead", ids: ["timeline.split"] },
      { keys: "`Delete`", action: "Remove the clip under the playhead", ids: ["timeline.removeClip"] },
      { keys: "`Alt+←` `Alt+→`", action: "Move the clip earlier / later", ids: ["timeline.moveClipEarlier", "timeline.moveClipLater"] },
      { keys: "`/`", action: "Preview the nearest cut", ids: ["timeline.previewCut"] },
      { keys: "`+` `-` `0`", action: "Zoom in / zoom out / fit everything", ids: ["timeline.zoomIn", "timeline.zoomOut", "timeline.zoomFit"] },
    ],
  },
  {
    // Spec 1.7 A footer: "Up/Down select  Enter open  Ctrl+N new project  Del remove from list".
    // Ctrl+N is the "everywhere" new project, so Home has no action of its own for it.
    context: "home",
    rows: [
      { keys: "`↑` / `↓`", action: "select", ids: ["home.selectPrev", "home.selectNext"] },
      { keys: "`Enter`", action: "open", ids: ["home.open"] },
      { keys: "`Del`", action: "remove from list", ids: ["home.remove"] },
    ],
  },
  {
    // Spec 1.7 E: "Cancel Esc  Export Enter", "Change C", progress "Cancel Esc",
    // done "Show in folder Enter  Copy path C  Close Esc".
    context: "export",
    rows: [
      { keys: "`Enter`", action: "Export", ids: ["export.confirm"] },
      { keys: "`Esc`", action: "Cancel", ids: ["export.cancel"] },
      { keys: "`C`", action: "Change", ids: ["export.changeFolder"] },
      { keys: "`Enter`", action: "Show in folder", ids: ["export.showInFolder"] },
      { keys: "`C`", action: "Copy path", ids: ["export.copyPath"] },
      { keys: "`Esc`", action: "Close", ids: ["export.close"] },
    ],
  },
];

/** Reads a key column into key groups: one group per action, each a list of canonical chords. */
function parseKeyColumn(keys: string, previous: string[][]): string[][] {
  const shiftAll = /^`Shift` \+ any of the above$/;
  if (shiftAll.test(keys)) {
    return previous.map((group) => group.map((c) => {
      const p = parseChord(`Shift+${c}`);
      if (p === null) throw new Error(`cannot add Shift to ${c}`);
      return p;
    }));
  }
  const groups: string[][] = [];
  for (const part of keys.split(" / ")) {
    const tokens = [...part.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    const chords = tokens.map((t) => {
      const c = parseChord(t);
      if (c === null) throw new Error(`cannot read key ${t} in ${keys}`);
      return c;
    });
    if (part.includes(" or ")) groups.push(chords);
    else for (const c of chords) groups.push([c]);
  }
  return groups;
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe("registry matches spec 1.10 (and the Home and Export keys of 1.7)", () => {
  for (const table of SPEC_TABLES) {
    it(`${table.context}: every row maps to exactly the right actions and keys`, () => {
      const previous: string[][] = [];
      const seen: string[] = [];
      for (const row of table.rows) {
        const groups = parseKeyColumn(row.keys, previous);
        expect(groups.length, `groups in ${row.keys}`).toBe(row.ids.length);
        groups.forEach((chords, i) => {
          const id = row.ids[i]!;
          const action = getAction(id);
          expect(action, `action ${id}`).toBeDefined();
          expect(action!.context).toBe(table.context);
          expect(sorted(action!.defaults), `${id} defaults`).toEqual(sorted(chords));
          seen.push(id);
        });
        previous.push(...groups);
      }
      const inRegistry = KEY_ACTIONS.filter((x) => x.context === table.context).map((x) => x.id);
      expect(sorted(inRegistry)).toEqual(sorted(seen));
      expect(new Set(seen).size).toBe(seen.length);
    });
  }

  it("the registry has no context the tables lack and no action outside them", () => {
    const all = SPEC_TABLES.flatMap((t) => t.rows.flatMap((r) => r.ids));
    expect(sorted(KEY_ACTIONS.map((x) => x.id))).toEqual(sorted(all));
  });

  it("registry order follows the table rows", () => {
    const all = SPEC_TABLES.flatMap((t) => t.rows.flatMap((r) => r.ids));
    expect(KEY_ACTIONS.map((x) => x.id)).toEqual(all);
  });
});

describe("registry invariants", () => {
  it("every action has a key, a label, a valid id and canonical chords", () => {
    for (const x of KEY_ACTIONS) {
      expect(x.defaults.length, x.id).toBeGreaterThan(0);
      expect(x.label.trim().length, x.id).toBeGreaterThan(0);
      expect(x.id).toMatch(new RegExp(`^${x.context}\\.[a-zA-Z0-9_]+$`));
      for (const c of x.defaults) expect(parseChord(c), `${x.id} ${c}`).toBe(c);
    }
  });

  it("ids are unique", () => {
    const ids = KEY_ACTIONS.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("no key is used twice in one context (nor clashes with everywhere)", () => {
    expect(findClashes(createKeymap().chords)).toEqual([]);
    // And the plain reading: within one context and dialog state, each chord once.
    const seen = new Map<string, string>();
    for (const x of KEY_ACTIONS) {
      const phases = x.phases ?? ["*"];
      for (const p of phases) for (const c of x.defaults) {
        const k = `${x.context}|${p}|${c}`;
        expect(seen.get(k), `${c} in ${x.context}/${p}: ${x.id} and ${seen.get(k)}`).toBeUndefined();
        seen.set(k, x.id);
      }
    }
  });

  it("the only defaults shared with an everywhere key are declared shadows (Export Esc)", () => {
    const everywhere = KEY_ACTIONS.filter((x) => x.context === "everywhere");
    const shared: string[] = [];
    for (const x of KEY_ACTIONS.filter((y) => y.context !== "everywhere")) {
      for (const e of everywhere) {
        if (x.defaults.some((c) => e.defaults.includes(c))) {
          shared.push(`${x.id}~${e.id}`);
          expect(scopesOverlap(x, e)).toBe(false);
          expect(x.shadows).toBe(e.id);
        }
      }
    }
    expect(sorted(shared)).toEqual(["export.cancel~everywhere.escape", "export.close~everywhere.escape"]);
  });

  it("repeat is on for stepping, moving and nudging, off for toggles", () => {
    const repeats = ["transcript.wordNext", "transcript.extendLinePrev", "timeline.stepFrameBack", "timeline.nudgeStartLater", "timeline.zoomIn", "home.selectNext"];
    const toggles = ["everywhere.playPause", "everywhere.playForward", "everywhere.switchView", "transcript.toggleCutText", "transcript.cut", "timeline.split", "everywhere.showShortcuts", "export.confirm"];
    for (const id of repeats) expect(getAction(id)!.repeat, id).toBe(true);
    for (const id of toggles) expect(getAction(id)!.repeat, id).toBe(false);
  });

  it("every screen hint names real actions", () => {
    for (const [screen, hints] of Object.entries(SCREEN_HINTS)) {
      for (const h of hints) for (const id of h.actions) expect(getAction(id), `${screen}: ${id}`).toBeDefined();
    }
  });
});
