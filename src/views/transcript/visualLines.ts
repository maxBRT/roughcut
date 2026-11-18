/**
 * Visual lines for Up / Down / Home / End in the Transcript view (spec 1.10). Lines depend on
 * how the text wraps, so they are measured from the rendered token elements (`data-pos`).
 * Where the needed line is not on screen or nothing is laid out yet, they fall back to the
 * paragraph rows: the start of the paragraph above or below, or the paragraph's ends.
 */
import type { ParagraphRow, RowModel } from "./rows";
import { rowOfBoundary } from "./rows";

/** The interface `transcript` asks for (`VisualLines`): each maps a caret boundary to a new one. */
export interface DomVisualLines {
  lineUp(boundary: number): number;
  lineDown(boundary: number): number;
  lineStart(boundary: number): number;
  lineEnd(boundary: number): number;
}

interface TokenBox {
  pos: number;
  left: number;
  right: number;
}

interface Line {
  top: number;
  tokens: TokenBox[];
}

/** Groups the rendered tokens into lines, top to bottom; null when nothing is laid out. */
export function measureLines(root: ParentNode): Line[] | null {
  const els = root.querySelectorAll<HTMLElement>("[data-pos]");
  const lines: Line[] = [];
  let laidOut = false;
  let current: Line | null = null;
  let lastBottom = Number.NEGATIVE_INFINITY;
  let lastPos = -2;
  for (const el of Array.from(els)) {
    const pos = Number(el.dataset.pos);
    if (!Number.isFinite(pos)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 || r.height > 0) laidOut = true;
    const mid = r.top + r.height / 2;
    // A new line when this token sits below the last one, or the positions are not consecutive (a row not rendered).
    if (!current || mid > lastBottom || pos !== lastPos + 1) {
      current = { top: r.top, tokens: [] };
      lines.push(current);
    }
    current.tokens.push({ pos, left: r.left, right: r.right });
    lastBottom = r.bottom;
    lastPos = pos;
  }
  return laidOut ? lines : null;
}

function lineIndexOf(lines: Line[], pos: number): number {
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.tokens;
    if (t.length > 0 && t[0]!.pos <= pos && pos <= t[t.length - 1]!.pos) return i;
  }
  return -1;
}

/** The boundary on `line` nearest the horizontal position `x` (the starts of its tokens, or the document end). */
function nearestOnLine(line: Line, x: number, tokenCount: number): number {
  let best = line.tokens[0]!.pos;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const t of line.tokens) {
    const d = Math.abs(t.left - x);
    if (d < bestDist) {
      best = t.pos;
      bestDist = d;
    }
    if (t.pos === tokenCount - 1 && Math.abs(t.right - x) < bestDist) {
      best = tokenCount;
      bestDist = Math.abs(t.right - x);
    }
  }
  return best;
}

/**
 * Visual lines over the rendered tokens under `getRoot()`, with `getModel()` for the
 * paragraph fallback. Both are read on every call, so the object can be registered once.
 */
export function createVisualLines(getRoot: () => ParentNode | null, getModel: () => RowModel | null): DomVisualLines {
  const fallback = (b: number, motion: "up" | "down" | "start" | "end"): number => {
    const model = getModel();
    if (!model || model.tokenCount === 0) return 0;
    const n = model.tokenCount;
    const r = rowOfBoundary(model, b);
    const k = model.paragraphRows.indexOf(r);
    const row = model.rows[r] as ParagraphRow | undefined;
    if (k < 0 || !row) return Math.max(0, Math.min(n, b));
    switch (motion) {
      case "start":
        return row.start;
      case "end":
        return row.end;
      case "up": {
        if (b > row.start) return row.start;
        return k > 0 ? model.paragraphStarts[k - 1]! : 0;
      }
      case "down":
        return k + 1 < model.paragraphStarts.length ? model.paragraphStarts[k + 1]! : n;
    }
  };

  const measured = (b: number): { lines: Line[]; index: number; x: number; n: number } | null => {
    const root = getRoot();
    const model = getModel();
    if (!root || !model || model.tokenCount === 0) return null;
    const n = model.tokenCount;
    const lines = measureLines(root);
    if (!lines) return null;
    const pos = Math.max(0, Math.min(b, n - 1));
    const index = lineIndexOf(lines, pos);
    if (index < 0) return null;
    const box = lines[index]!.tokens.find((t) => t.pos === pos)!;
    return { lines, index, x: b >= n ? box.right : box.left, n };
  };

  return {
    lineUp(b) {
      const m = measured(b);
      if (!m) return fallback(b, "up");
      if (m.index === 0) return m.lines[0]!.tokens[0]!.pos === 0 ? 0 : fallback(b, "up");
      return nearestOnLine(m.lines[m.index - 1]!, m.x, m.n);
    },
    lineDown(b) {
      const m = measured(b);
      if (!m) return fallback(b, "down");
      if (m.index === m.lines.length - 1) {
        const last = m.lines[m.index]!.tokens;
        return last[last.length - 1]!.pos === m.n - 1 ? m.n : fallback(b, "down");
      }
      return nearestOnLine(m.lines[m.index + 1]!, m.x, m.n);
    },
    lineStart(b) {
      const m = measured(b);
      if (!m) return fallback(b, "start");
      return m.lines[m.index]!.tokens[0]!.pos;
    },
    lineEnd(b) {
      const m = measured(b);
      if (!m) return fallback(b, "end");
      const t = m.lines[m.index]!.tokens;
      return t[t.length - 1]!.pos + 1;
    },
  };
}
