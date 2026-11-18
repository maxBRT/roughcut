/**
 * Undo history (spec 2.4.7, 3.8). `undo` is oldest first, so its last element is the state
 * the next undo restores. `redo` mirrors it: its last element is the state the next redo
 * restores. A command that changes nothing returns the very same document object.
 */
import type { Clip, EditDocument, EditState, SourceRange } from "../types";

/** A document with the given clips, nothing dismissed and no history. */
export function createEditDocument(clips: readonly Clip[] = [], dismissed: readonly SourceRange[] = []): EditDocument {
  return { current: { clips: clips.map((c) => ({ ...c })), dismissed: dismissed.map((r) => ({ ...r })) }, undo: [], redo: [] };
}

/** Whether two states hold exactly the same clips (ids included) and dismissed ranges. */
export function sameState(a: EditState, b: EditState): boolean {
  if (a === b) return true;
  if (a.clips.length !== b.clips.length || a.dismissed.length !== b.dismissed.length) return false;
  for (let i = 0; i < a.clips.length; i++) {
    const x = a.clips[i]!;
    const y = b.clips[i]!;
    if (x !== y && (x.id !== y.id || x.sourceId !== y.sourceId || x.start !== y.start || x.end !== y.end)) return false;
  }
  for (let i = 0; i < a.dismissed.length; i++) {
    const x = a.dismissed[i]!;
    const y = b.dismissed[i]!;
    if (x !== y && (x.sourceId !== y.sourceId || x.start !== y.start || x.end !== y.end)) return false;
  }
  return true;
}

/**
 * Makes `next` current as one undo step and clears redo. Returns `doc` itself when `next`
 * equals the current state (no undo step is added).
 */
export function commit(doc: EditDocument, next: EditState): EditDocument {
  if (sameState(doc.current, next)) return doc;
  return { current: next, undo: [...doc.undo, doc.current], redo: [] };
}

/** Whether there is a step to undo. */
export function canUndo(doc: EditDocument): boolean {
  return doc.undo.length > 0;
}

/** Whether there is a step to redo. */
export function canRedo(doc: EditDocument): boolean {
  return doc.redo.length > 0;
}

/** The previous state becomes current. Returns `doc` itself when there is nothing to undo. */
export function undo(doc: EditDocument): EditDocument {
  const prev = doc.undo[doc.undo.length - 1];
  if (prev === undefined) return doc;
  return { current: prev, undo: doc.undo.slice(0, -1), redo: [...doc.redo, doc.current] };
}

/** The next state becomes current. Returns `doc` itself when there is nothing to redo. */
export function redo(doc: EditDocument): EditDocument {
  const next = doc.redo[doc.redo.length - 1];
  if (next === undefined) return doc;
  return { current: next, undo: [...doc.undo, doc.current], redo: doc.redo.slice(0, -1) };
}
