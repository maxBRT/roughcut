/**
 * The rows of the Transcript view: source headers, paragraphs (tokens, caret, selection, find
 * hits, I / O marks, suggestion markers and reason lines) and untranscribed stretches. Each
 * row is memoised and receives only what concerns it, so moving the caret redraws one or two.
 * Clicks are handled by the view through `data-pos` / `data-row`; the suggestion buttons
 * dispatch their own actions.
 */
import { memo, type MouseEvent, type ReactNode } from "react";
import { useDispatch } from "../../state";
import { Key, PauseChip } from "../../ui";
import { formatClock, formatLength, formatSecondsLeft } from "./format";
import type { DisplayToken, ParagraphRow, RowMatch, SuggestionView, UntranscribedRow } from "./rows";

const KIND_LABELS: Record<SuggestionView["suggestion"]["kind"], string> = {
  retake: "retake",
  false_start: "false start",
  aside: "aside",
  dead_air: "dead air",
};

/** What a paragraph needs beyond its row; every field is "none" (-1, null, empty) when it does not concern the row. */
export interface ParagraphProps {
  row: ParagraphRow;
  /** Selected tokens [selFrom, selTo), clipped to the row; equal when nothing is selected here. */
  selFrom: number;
  selTo: number;
  /** The caret boundary when it is drawn in this row, else -1. */
  caret: number;
  /** Playing: the caret does not blink. */
  steady: boolean;
  matches: readonly RowMatch[];
  /** Token positions of the I and O marks when in this row, else -1. */
  inPos: number;
  outPos: number;
  /** The marked range [markFrom, markTo] clipped to the row, or -1 / -1. */
  markFrom: number;
  markTo: number;
  /** The suggestion A / D act on, when it touches this row. */
  activeSuggestion: string | null;
  pendingOrder: ReadonlyMap<string, number>;
  pendingCount: number;
}

function inMatch(matches: readonly RowMatch[], p: number): 0 | 1 | 2 {
  let hit: 0 | 1 | 2 = 0;
  for (const m of matches) {
    if (p >= m.from && p < m.to) {
      if (m.current) return 2;
      hit = 1;
    }
  }
  return hit;
}

/** The classes a token (or the space after it) carries. */
function tokenClasses(t: DisplayToken, p: number, props: ParagraphProps): string[] {
  const c: string[] = [];
  if (t.keep === "cut") c.push("rc-cut");
  else if (t.keep === "partial") c.push("rc-tx-partial");
  if (p >= props.selFrom && p < props.selTo) c.push("rc-sel");
  if (t.suggestionId !== null && t.suggestionState === "pending") c.push("rc-tx-sug");
  const hit = inMatch(props.matches, p);
  if (hit === 2) c.push("rc-tx-find-hit", "rc-tx-find-hit--current");
  else if (hit === 1) c.push("rc-tx-find-hit");
  if (props.markFrom >= 0 && p >= props.markFrom && p <= props.markTo) c.push("rc-tx-marked");
  return c;
}

function tokenLabel(t: DisplayToken): string {
  const tok = t.token;
  if (tok.kind === "word") return tok.text;
  if (tok.kind === "pause") return `pause ${formatLength(tok.end - tok.start)}`;
  return `unrecognised speech ${formatLength(tok.end - tok.start)}`;
}

function TokenView({ t, p, classes }: { t: DisplayToken; p: number; classes: string[] }) {
  const tok = t.token;
  const common = {
    "data-pos": p,
    "data-kind": tok.kind,
    "data-keep": t.keep,
    "data-suggestion": t.suggestionState === "pending" ? (t.suggestionId ?? undefined) : undefined,
  };
  if (tok.kind === "pause") {
    const isSel = classes.includes("rc-sel");
    const extra = classes.filter((c) => c !== "rc-sel" && c !== "rc-cut" && c !== "rc-tx-sug").join(" ");
    return (
      <PauseChip
        seconds={(tok.end - tok.start) / 1_000_000}
        cut={t.keep === "cut"}
        selected={isSel}
        suggested={classes.includes("rc-tx-sug")}
        className={extra || undefined}
        {...common}
      />
    );
  }
  if (tok.kind === "unrecognised") {
    const isSel = classes.includes("rc-sel");
    return (
      <span
        className={["rc-pause", "rc-tx-unrec", t.keep === "cut" && "rc-pause--cut", isSel && "rc-pause--sel", classes.includes("rc-tx-sug") && "rc-pause--sug", ...classes.filter((c) => c.startsWith("rc-tx-find") || c === "rc-tx-marked")]
          .filter(Boolean)
          .join(" ")}
        title="Speech the transcriber could not turn into words"
        {...common}
      >
        {tokenLabel(t)}
      </span>
    );
  }
  return (
    <span className={["rc-tx-w", ...classes].join(" ")} {...common}>
      {tok.text}
    </span>
  );
}

function Caret({ steady }: { steady: boolean }) {
  return <i className={steady ? "rc-caret rc-tx-caret--steady" : "rc-caret"} data-caret="" aria-hidden="true" />;
}

function MarkFlag({ which }: { which: "in" | "out" }) {
  return (
    <span className="rc-tx-mark" data-mark={which} title={which === "in" ? "Range start (I)" : "Range end (O)"}>
      {which === "in" ? "I" : "O"}
    </span>
  );
}

/**
 * The text of a suggestion's reason line, in the mockup's lower-case mono style:
 * "retake · said again later · kept take at 0:36 · 2 of 15". The kind leads; a reason that
 * already starts with the kind ("Retake, said again…") replaces it instead of repeating it.
 */
export function suggestionLineText(s: SuggestionView["suggestion"], order: number, count: number): string {
  const kind = KIND_LABELS[s.kind];
  const raw = s.reason.trim();
  const reason = raw ? raw.charAt(0).toLowerCase() + raw.slice(1) : "";
  const parts: string[] = [];
  if (reason.toLowerCase().startsWith(kind)) parts.push(reason);
  else {
    parts.push(kind);
    if (reason) parts.push(reason);
  }
  if (s.keptVersionAt !== undefined) parts.push(`kept take at ${formatClock(s.keptVersionAt)}`);
  if (order > 0) parts.push(`${order} of ${count}`);
  return parts.join(" · ");
}

function SuggestionLine({ view, current, order, count }: { view: SuggestionView; current: boolean; order: number; count: number }) {
  const dispatch = useDispatch();
  const s = view.suggestion;
  const id = s.id;
  const text = suggestionLineText(s, order, count);
  // The buttons never take focus, so Space and Enter keep meaning play.
  const noFocus = (e: MouseEvent) => e.preventDefault();
  return (
    <div className={current ? "rc-tx-why rc-tx-why--current" : "rc-tx-why"} data-suggestion-line={id} data-current={current || undefined}>
      <button type="button" tabIndex={-1} className="rc-tx-plain rc-tx-why__reason" title={text} onMouseDown={noFocus} onClick={() => void dispatch("ui.selectSuggestion", { suggestionId: id })}>
        {text}
      </button>
      <button type="button" tabIndex={-1} className="rc-tx-plain rc-hint" data-accept={id} onMouseDown={noFocus} onClick={() => void dispatch("transcript.acceptSuggestion", { suggestionId: id })}>
        <Key>a</Key>cut
      </button>
      <button type="button" tabIndex={-1} className="rc-tx-plain rc-hint" data-dismiss={id} onMouseDown={noFocus} onClick={() => void dispatch("transcript.dismissSuggestion", { suggestionId: id })}>
        <Key>d</Key>keep
      </button>
    </div>
  );
}

/** One paragraph of the transcript. */
export const ParagraphView = memo(function ParagraphView(props: ParagraphProps) {
  const { row, caret, steady, inPos, outPos } = props;
  const tokens = row.block.tokens;
  const out: ReactNode[] = [];
  let prevClasses: string[] | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const p = row.start + i;
    const t = tokens[i]!;
    const classes = tokenClasses(t, p, props);
    if (i > 0) {
      // The space between two tokens carries what both share, so strikes, highlights and underlines run on.
      const shared = prevClasses!.filter((c) => classes.includes(c) && c !== "rc-tx-find-hit--current");
      if (classes.includes("rc-tx-find-hit--current") && prevClasses!.includes("rc-tx-find-hit--current")) shared.push("rc-tx-find-hit--current");
      out.push(
        <span key={`g${p}`} className={["rc-tx-gap", ...shared].join(" ")}>
          {" "}
        </span>,
      );
    }
    if (caret === p) out.push(<Caret key="caret" steady={steady} />);
    if (inPos === p) out.push(<MarkFlag key="in" which="in" />);
    out.push(<TokenView key={p} t={t} p={p} classes={classes} />);
    if (outPos === p) out.push(<MarkFlag key="out" which="out" />);
    prevClasses = classes;
  }
  if (caret === row.end) out.push(<Caret key="caret" steady={steady} />);
  if (row.arriving) out.push(<i key="blk" className="rc-blk" data-arriving="" aria-hidden="true" />);
  return (
    <div
      className={row.block.allCut ? "rc-tx-p rc-tx-p--cut" : "rc-tx-p"}
      data-row="paragraph"
      data-start={row.start}
      data-end={row.end}
    >
      <time data-row-time="">{formatClock(row.time)}</time>
      <div>
        <div className="rc-tx-p__text">{out}</div>
        {row.endsSuggestions.map((v) => (
          <SuggestionLine
            key={v.suggestion.id}
            view={v}
            current={props.activeSuggestion === v.suggestion.id}
            order={props.pendingOrder.get(v.suggestion.id) ?? 0}
            count={props.pendingCount}
          />
        ))}
      </div>
    </div>
  );
});

/** The progress shown while a transcript is still being produced. */
export interface TranscribingInfo {
  progress: number;
  secondsLeft: number | null;
}

/** Kept time with no text: still being transcribed, no transcript, or no speech. */
export const UntranscribedView = memo(function UntranscribedView({
  row,
  transcribing,
  caret = null,
}: {
  row: UntranscribedRow;
  transcribing: TranscribingInfo | null;
  /** The playhead is in this stretch: the caret is drawn at its start ("steady" while playing). */
  caret?: "blink" | "steady" | null;
}) {
  const b = row.block;
  const span = `${formatClock(b.range.start)} – ${formatClock(b.range.end)}`;
  // Text arrives in one stretch per source (row.arrival); later partial stretches just wait.
  const arrives = b.status === "partial" && row.arrival !== "none";
  let note: string;
  if (b.status === "silent") note = `no speech · ${span}`;
  else if (b.status === "partial" && !arrives) note = `not transcribed yet · ${span}`;
  else if (b.status === "partial") {
    note = "text appears here as it is transcribed";
    if (transcribing) {
      note += ` · ${Math.round(transcribing.progress * 100)}%`;
      const left = transcribing.secondsLeft !== null ? formatSecondsLeft(transcribing.secondsLeft) : "";
      if (left) note += ` · ${left}`;
    }
  } else note = transcribing ? `waiting for the transcript · ${span}` : `no transcript · ${span}`;
  return (
    <div className="rc-tx-u" data-row="untranscribed" data-status={b.status} data-time={b.sequenceTime} data-current={caret ? "" : undefined}>
      <time>{formatClock(b.range.start)}</time>
      <div className="rc-tx-u__note">
        {caret && <Caret steady={caret === "steady"} />}
        {arrives ? "…  " : ""}
        {note}
        {arrives && row.arrival === "block" && <i className="rc-blk" data-arriving="" aria-hidden="true" />}
      </div>
    </div>
  );
});
