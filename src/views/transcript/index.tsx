/**
 * The Transcript view (spec 1.7 B and C, 1.8 "In the transcript", 2.4.11): the sequence written
 * out as text, drawn from the store's `layout`. Only the rows on screen are rendered
 * (@tanstack/react-virtual), so an hour of text stays fast. The caret and the word-snapped
 * selection are the app's own; the browser's text selection is off.
 *
 * Mouse: click places the caret (Shift+click extends), drag selects by word, double-click
 * selects a word, a click on a time puts the caret at its paragraph. The caret follows playback
 * and is kept in view. The view registers its visual lines for Up / Down / Home / End.
 * It reads the store and dispatches actions only (spec 3.6 rule 1).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { measureElement as defaultMeasureElement, useVirtualizer } from "@tanstack/react-virtual";
import {
  selectActiveSuggestion,
  selectTranscribing,
  useDispatch,
  useRoughcut,
  useVisualLinesRegistration,
} from "../../state";
import { EmptyState, Key } from "../../ui";
import {
  buildRows,
  markPosition,
  matchesByRow,
  rowOfBoundary,
  untranscribedRowAt,
  untranscribedRowIndexes,
  type ParagraphRow,
  type Row,
  type RowMatch,
  type RowModel,
} from "./rows";
import { ParagraphView, UntranscribedView, type TranscribingInfo } from "./rowViews";
import { createVisualLines } from "./visualLines";
import "./transcript.css";

const NO_MATCHES: readonly RowMatch[] = [];
/** The find matches drawn while the find box is closed: none. */
const NO_FIND_MATCHES: never[] = [];
const NO_ROWS: readonly Row[] = [];
const NO_INDEXES: readonly number[] = [];
/** While playing, a scroll by the user holds off following the caret for this long. */
const FOLLOW_PAUSE_MS = 3000;
/** Space kept between the caret and the top or bottom edge when scrolling it into view. */
const CARET_MARGIN = 48;

/** A row height guess before it is measured: ~70 characters per 26px line. */
function estimateRow(row: Row | undefined): number {
  if (!row) return 40;
  if (row.kind === "source") return 36;
  if (row.kind === "untranscribed") return 42;
  let chars = 0;
  for (const t of row.block.tokens) chars += t.token.kind === "word" ? t.token.text.length + 1 : 14;
  const lines = Math.max(1, Math.ceil(chars / 70));
  return lines * 26 + 16 + row.endsSuggestions.length * 33;
}

/** The find box (Ctrl+F): typing searches, Enter / Shift+Enter step through matches, Esc closes. */
function FindBar() {
  const find = useRoughcut((s) => s.find);
  const dispatch = useDispatch();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!find.open) return;
    input.current?.focus();
    input.current?.select();
  }, [find.open, find.focusRequest]);
  if (!find.open) return null;
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    void dispatch(e.shiftKey ? "ui.findPrevious" : "ui.findNext");
  };
  const count = find.matches.length;
  const status = find.query.trim() === "" ? "" : count === 0 ? "no matches" : find.index >= 0 ? `${find.index + 1} of ${count}` : `${count} found`;
  return (
    <div className="rc-tx-find" role="search">
      <input
        ref={input}
        className="rc-tx-find__input"
        type="search"
        aria-label="Find in transcript"
        placeholder="find"
        value={find.query}
        spellCheck={false}
        onChange={(e) => void dispatch("ui.findQuery", { query: e.target.value })}
        onKeyDown={onKeyDown}
      />
      <span className="rc-tx-find__count" aria-live="polite" data-find-status="">
        {status}
      </span>
      <button type="button" className="rc-tx-plain rc-hint" onClick={() => void dispatch("ui.findClose")}>
        <Key>esc</Key>close
      </button>
    </div>
  );
}

/** The line above the text: the find box, and a note while cut text is hidden. */
function TopBar({ hidden }: { hidden: boolean }) {
  const findOpen = useRoughcut((s) => s.find.open);
  const dispatch = useDispatch();
  if (!findOpen && !hidden) return <div className="rc-tx__bar" />;
  return (
    <div className="rc-tx__bar">
      <FindBar />
      {hidden && (
        <button
          type="button"
          tabIndex={-1}
          className="rc-tx-plain rc-hint"
          data-cut-hidden=""
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void dispatch("transcript.toggleCutText")}
        >
          cut text hidden
          <Key>h</Key>show
        </button>
      )}
    </div>
  );
}

/**
 * A word drag in progress. It starts on a token (lo = hi = that token) or on a boundary between
 * tokens b-1 and b (lo = b-1, hi = b): the selection then runs from boundary b to the far side
 * of the word under the pointer.
 */
interface Drag {
  lo: number;
  hi: number;
  /** The token last dragged over, -1 before the pointer has left where it was pressed. */
  last: number;
}

/**
 * The caret boundary for a press inside a paragraph's text that is not on a token: the space
 * between two words, an I / O flag, the caret or the arriving block. It is the boundary before
 * the next token in the line, or after the previous one, or the paragraph's end.
 */
function boundaryNear(el: Element, rowEnd: number): number {
  for (let n = el.nextElementSibling; n; n = n.nextElementSibling) {
    if (n instanceof HTMLElement && n.dataset.pos !== undefined) return Number(n.dataset.pos);
  }
  for (let n = el.previousElementSibling; n; n = n.previousElementSibling) {
    if (n instanceof HTMLElement && n.dataset.pos !== undefined) return Number(n.dataset.pos) + 1;
  }
  return rowEnd;
}

/** The transcript as text, in playing order (spec 1.7 C). Takes no props: reads the store. */
export function TranscriptView() {
  const layout = useRoughcut((s) => s.layout);
  const selection = useRoughcut((s) => s.selection);
  const marks = useRoughcut((s) => s.marks);
  // Matches are highlighted only while the find box is open: closing it (Esc) clears them.
  const findOpen = useRoughcut((s) => s.find.open);
  const allMatches = useRoughcut((s) => s.find.matches);
  const matches = findOpen ? allMatches : NO_FIND_MATCHES;
  const matchIndex = useRoughcut((s) => s.find.index);
  const playing = useRoughcut((s) => s.playhead.playing);
  const playPos = useRoughcut((s) => s.playhead.position);
  const hidden = useRoughcut((s) => s.session.cutTextHidden);
  const active = useRoughcut(selectActiveSuggestion);
  const transcribingSel = useRoughcut(selectTranscribing);
  const dispatch = useDispatch();
  const register = useVisualLinesRegistration();

  const model = useMemo(() => (layout ? buildRows(layout) : null), [layout]);
  const rows = model?.rows ?? NO_ROWS;
  const scrollRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<RowModel | null>(model);
  modelRef.current = model;

  const transcribing: TranscribingInfo | null = transcribingSel;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => estimateRow(rows[i]),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 8,
    measureElement: (el, entry, instance) => {
      const h = defaultMeasureElement(el, entry, instance);
      return h > 0 ? h : estimateRow(rows[instance.indexFromElement(el)]);
    },
  });

  // Visual lines for Up / Down / Home / End, registered once; they read the latest rows.
  useEffect(() => {
    register(createVisualLines(() => scrollRef.current, () => modelRef.current));
    return () => register(null);
  }, [register]);

  // ---- per-row derived data ----
  const n = model?.tokenCount ?? 0;
  const selFrom = Math.min(selection.anchor, selection.focus);
  const selTo = Math.max(selection.anchor, selection.focus);
  // The playhead in kept time that has no text (no speech, not transcribed yet, another
  // source's silence): there is no word for the caret to sit on, so that row holds the caret
  // and is kept in view instead (caret = playhead, spec 1.8).
  const untranscribedRows = useMemo(() => (model ? untranscribedRowIndexes(model) : NO_INDEXES), [model]);
  const playRow = model && playPos ? untranscribedRowAt(model, untranscribedRows, playPos) : -1;
  const caretRow = model && playRow < 0 ? rowOfBoundary(model, selection.focus) : -1;
  const hitsByRow = useMemo(() => (model ? matchesByRow(model, matches, matchIndex) : new Map<number, readonly RowMatch[]>()), [model, matches, matchIndex]);
  const inPos = useMemo(() => (model ? markPosition(model, marks.in, "in") : -1), [model, marks.in]);
  const outPos = useMemo(() => (model ? markPosition(model, marks.out, "out") : -1), [model, marks.out]);
  const markRange = inPos >= 0 && outPos >= 0 && inPos <= outPos ? { from: inPos, to: outPos } : null;
  const activeId = active?.suggestion.id ?? null;

  // ---- the caret follows playback and stays in view ----
  const lastWheel = useRef(0);
  const followKey = `${selection.focus}|${layout?.hideCut ? 1 : 0}|${playRow}`;
  const lastFollowKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!model || (caretRow < 0 && playRow < 0)) return;
    if (lastFollowKey.current === followKey) return;
    lastFollowKey.current = followKey;
    if (playing && Date.now() - lastWheel.current < FOLLOW_PAUSE_MS) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    if (playRow >= 0) {
      virtualizer.scrollToIndex(playRow, { align: "auto" });
      return;
    }
    const caretEl = scroller.querySelector<HTMLElement>("[data-caret]");
    if (!caretEl) {
      virtualizer.scrollToIndex(caretRow, { align: "center" });
      return;
    }
    const box = scroller.getBoundingClientRect();
    const c = caretEl.getBoundingClientRect();
    if (box.height === 0) return;
    if (c.top < box.top + CARET_MARGIN) scroller.scrollTop -= box.top + CARET_MARGIN - c.top;
    else if (c.bottom > box.bottom - CARET_MARGIN) scroller.scrollTop += c.bottom - (box.bottom - CARET_MARGIN);
  });

  // ---- N / Shift+N: the current suggestion's reason line (with its A / D keys) is in view ----
  const current = useRoughcut((s) => s.currentSuggestion);
  const lastShownSuggestion = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (current === lastShownSuggestion.current) return;
    lastShownSuggestion.current = current;
    const scroller = scrollRef.current;
    if (!current || !scroller) return;
    const line = scroller.querySelector<HTMLElement>(`[data-suggestion-line="${CSS.escape(current)}"]`);
    if (!line) return;
    const box = scroller.getBoundingClientRect();
    const r = line.getBoundingClientRect();
    if (box.height === 0) return;
    const need = r.bottom - (box.bottom - CARET_MARGIN);
    if (need <= 0) return;
    // Never so far that the start of the suggestion (where the caret is) leaves the top.
    const caretEl = scroller.querySelector<HTMLElement>("[data-caret]");
    const room = caretEl ? caretEl.getBoundingClientRect().top - (box.top + CARET_MARGIN) : need;
    const by = Math.min(need, room);
    if (by > 0) scroller.scrollTop += by;
  });

  // ---- mouse: caret, word selection by drag, double-click ----
  const drag = useRef<Drag | null>(null);
  useEffect(() => {
    const end = () => {
      drag.current = null;
    };
    window.addEventListener("mouseup", end);
    return () => window.removeEventListener("mouseup", end);
  }, []);

  const onMouseDown = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const target = e.target as Element;
      if (target.closest("button, input, a")) return;
      const rowEl = target.closest<HTMLElement>("[data-row]");
      if (!rowEl) return;
      // Every press the transcript handles moves focus here (out of the find box), so its keys work.
      e.preventDefault();
      scrollRef.current?.focus({ preventScroll: true });
      const tok = target.closest<HTMLElement>("[data-pos]");
      if (tok) {
        const p = Number(tok.dataset.pos);
        if (e.detail >= 2) {
          drag.current = { lo: p, hi: p, last: p };
          void dispatch("ui.selectTokens", { anchorToken: p, focusToken: p });
          return;
        }
        const r = tok.getBoundingClientRect();
        const boundary = r.width > 0 && e.clientX > r.left + r.width / 2 ? p + 1 : p;
        if (e.shiftKey) {
          void dispatch("ui.placeCaret", { boundary, extend: true });
          return;
        }
        drag.current = { lo: p, hi: p, last: -1 };
        void dispatch("ui.placeCaret", { boundary });
        return;
      }
      if (rowEl.dataset.row === "paragraph") {
        const end = Number(rowEl.dataset.end);
        let boundary: number;
        if (target.closest("time")) boundary = Number(rowEl.dataset.start);
        else {
          // A piece of the text line (a space, a flag, the caret): the boundary next to it.
          // Anything else in the paragraph (the empty area after its last line): its end.
          const text = target.closest(".rc-tx-p__text");
          boundary = text && target !== text ? boundaryNear(target.parentElement === text ? target : target.closest(".rc-tx-p__text > *")!, end) : end;
        }
        if (e.shiftKey) {
          void dispatch("ui.placeCaret", { boundary, extend: true });
          return;
        }
        drag.current = { lo: boundary - 1, hi: boundary, last: -1 };
        void dispatch("ui.placeCaret", { boundary });
      } else if (rowEl.dataset.row === "untranscribed") {
        void dispatch("ui.seek", { time: Number(rowEl.dataset.time) });
      }
    },
    [dispatch],
  );

  const onMouseMove = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d) return;
      if ((e.buttons & 1) === 0) {
        drag.current = null;
        return;
      }
      const tok = (e.target as Element).closest<HTMLElement>("[data-pos]");
      if (!tok) return;
      const q = Number(tok.dataset.pos);
      if (q === d.last || (d.last === -1 && d.lo === d.hi && q === d.lo)) return;
      d.last = q;
      if (d.lo === d.hi) {
        void dispatch("ui.selectTokens", { anchorToken: d.lo, focusToken: q });
        return;
      }
      // From a boundary (the press put the caret there): extend to the far side of the word.
      void dispatch("ui.placeCaret", { boundary: q >= d.hi ? q + 1 : q, extend: true });
    },
    [dispatch],
  );

  const onWheel = useCallback(() => {
    lastWheel.current = Date.now();
  }, []);

  // ---- render ----
  if (!layout || !model) {
    return (
      <section data-view="transcript" className="rc-tx">
        <EmptyState className="rc-tx-empty" title="No project open" />
      </section>
    );
  }

  const renderRow = (index: number, row: Row) => {
    if (row.kind === "source") {
      return (
        <div className="rc-tx-src" data-row="source">
          {row.block.name}
        </div>
      );
    }
    if (row.kind === "untranscribed") {
      return (
        <UntranscribedView
          row={row}
          transcribing={row.block.status === "partial" ? transcribing : null}
          caret={index === playRow ? (playing ? "steady" : "blink") : null}
        />
      );
    }
    return paragraphFor(row, index);
  };

  // Each paragraph gets only the parts of the caret, selection, marks and matches inside it.
  const paragraphFor = (row: ParagraphRow, index: number) => {
    const lastRow = index === model.paragraphRows[model.paragraphRows.length - 1];
    const caret = index === caretRow ? (selection.focus >= n && lastRow ? row.end : selection.focus) : -1;
    const from = Math.max(selFrom, row.start);
    const to = Math.min(selTo, row.end);
    const hasSel = to > from;
    return (
      <ParagraphView
        row={row}
        selFrom={hasSel ? from : -1}
        selTo={hasSel ? to : -1}
        caret={caret}
        steady={playing}
        matches={hitsByRow.get(index) ?? NO_MATCHES}
        inPos={inPos >= row.start && inPos < row.end ? inPos : -1}
        outPos={outPos >= row.start && outPos < row.end ? outPos : -1}
        markFrom={markRange && markRange.to >= row.start && markRange.from < row.end ? Math.max(markRange.from, row.start) : -1}
        markTo={markRange && markRange.to >= row.start && markRange.from < row.end ? Math.min(markRange.to, row.end - 1) : -1}
        activeSuggestion={activeId !== null && row.suggestionIds.has(activeId) ? activeId : null}
        pendingOrder={model.pendingOrder}
        pendingCount={model.pendingCount}
      />
    );
  };

  return (
    <section data-view="transcript" className="rc-tx" data-hide-cut={hidden || undefined}>
      <TopBar hidden={hidden} />
      <div
        ref={scrollRef}
        className="rc-tx__scroll"
        data-tx-scroller=""
        role="document"
        aria-label="Transcript"
        tabIndex={-1}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onWheel={onWheel}
      >
        {rows.length === 0 ? (
          <EmptyState className="rc-tx-empty" title="Nothing in the sequence" detail="Press Ctrl+O to add footage." />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}
                >
                  {renderRow(item.index, row)}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
