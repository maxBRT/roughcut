/**
 * Shared presentational components carried over from mockups/roughcut-mockups.html.
 * Props in, markup out: no app state, no calls to the core. Styles live in components.css.
 */
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  LiHTMLAttributes,
  ReactNode,
} from "react";

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ */
/* Key: a keycap label, e.g. <Key>ctrl n</Key>                         */
/* ------------------------------------------------------------------ */

export interface KeyProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
}

/** A keycap label (mono, outlined). Renders a <kbd>. */
export function Key({ children, className, ...rest }: KeyProps) {
  return (
    <kbd className={cx("rc-cap", className)} {...rest}>
      {children}
    </kbd>
  );
}

/** Several keycaps side by side, e.g. ["i", "o"]. */
export function Keys({ keys }: { keys: readonly string[] }) {
  return (
    <span className="rc-hint__keys">
      {keys.map((k, i) => (
        <Key key={`${k}-${i}`}>{k}</Key>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Led                                                                 */
/* ------------------------------------------------------------------ */

/** The small status light used in the view switch and notices. */
export function Led({ on = false }: { on?: boolean }) {
  return <i className={cx("rc-led", on && "rc-led--on")} aria-hidden="true" />;
}

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

export type ButtonVariant = "primary" | "flat";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** "primary" is the one filled accent key of a view; everything else is "flat". */
  variant?: ButtonVariant;
  /** Optional keycap shown after the label, e.g. "enter". */
  shortcut?: string;
  /** Optional leading LED. */
  led?: boolean;
  children: ReactNode;
}

/** A key-style button. Use variant="primary" for at most one button per view. */
export function Button({
  variant = "flat",
  shortcut,
  led,
  className,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx("rc-key", variant === "primary" && "rc-key--fill", className)}
      {...rest}
    >
      {led !== undefined && <Led on={led} />}
      {children}
      {shortcut !== undefined && <Key aria-hidden="true">{shortcut}</Key>}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* AppFrame (the "device") with header bar                             */
/* ------------------------------------------------------------------ */

export interface AppFrameProps {
  /** Project name shown next to the brand (editor screens only). */
  project?: ReactNode;
  /** Centre of the header: usually a <ViewSwitch>. */
  center?: ReactNode;
  /** Right of the header: usually a kept <Readout> and the Export button. */
  right?: ReactNode;
  /** Brand text; defaults to "roughcut". */
  brand?: ReactNode;
  /** Draws the rounded border of the mockup device (off for the real window). */
  boxed?: boolean;
  className?: string;
  children?: ReactNode;
}

/** The whole window: 32px header bar, then the screen body. */
export function AppFrame({
  project,
  center,
  right,
  brand = "roughcut",
  boxed = false,
  className,
  children,
}: AppFrameProps) {
  return (
    <div className={cx("rc-frame", boxed && "rc-frame--boxed", className)}>
      <header className="rc-top">
        <div className="rc-top__l">
          <span className="rc-brand">{brand}</span>
          {project !== undefined && <span className="rc-proj">{project}</span>}
        </div>
        {center !== undefined && <div className="rc-top__c">{center}</div>}
        {right !== undefined && <div className="rc-top__r">{right}</div>}
      </header>
      <main className="rc-frame__body">{children}</main>
    </div>
  );
}

/** Alias: the mockup calls the window frame the "device". */
export const Device = AppFrame;

/* ------------------------------------------------------------------ */
/* ViewSwitch: Transcript | Timeline                                   */
/* ------------------------------------------------------------------ */

export type EditorView = "transcript" | "timeline";

export interface ViewSwitchProps {
  value: EditorView;
  onChange?: (view: EditorView) => void;
  /** Labels; default "transcript" and "timeline". */
  labels?: Partial<Record<EditorView, ReactNode>>;
}

const VIEWS: readonly EditorView[] = ["transcript", "timeline"];

/** The two view keys in the header; the current one has a lit LED. */
export function ViewSwitch({ value, onChange, labels }: ViewSwitchProps) {
  return (
    <div className="rc-views" role="tablist" aria-label="View">
      {VIEWS.map((v) => {
        const on = v === value;
        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            data-view={v}
            className="rc-key"
            onClick={onChange ? () => onChange(v) : undefined}
          >
            <Led on={on} />
            {labels?.[v] ?? v}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Readout and Timecode                                                */
/* ------------------------------------------------------------------ */

export interface ReadoutProps {
  label: ReactNode;
  value: ReactNode;
  className?: string;
}

/** A mono figure with a label before it, e.g. "kept 41:12". */
export function Readout({ label, value, className }: ReadoutProps) {
  return (
    <span className={cx("rc-readout", className)}>
      <span className="rc-readout__l">{label}</span>
      <b className="rc-readout__v">{value}</b>
    </span>
  );
}

/** The large playhead time with the total after it, e.g. "0:28.2 / 41:12". */
export function Timecode({ value, total }: { value: ReactNode; total?: ReactNode }) {
  return (
    <span className="rc-tc">
      {value}
      {total !== undefined && <small className="rc-tc__total">/ {total}</small>}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* ShortcutBar                                                         */
/* ------------------------------------------------------------------ */

export interface ShortcutHint {
  /** One or more keycaps, e.g. ["i", "o"]. */
  keys: readonly string[];
  label: ReactNode;
}

export interface ShortcutBarProps {
  items: readonly ShortcutHint[];
  /** Pushed to the right end, e.g. { keys: ["?"], label: "all shortcuts" }. */
  trailing?: ShortcutHint;
  className?: string;
}

/** The bottom bar of key hints. */
export function ShortcutBar({ items, trailing, className }: ShortcutBarProps) {
  return (
    <ul className={cx("rc-hints", className)} aria-label="Shortcuts">
      {items.map((h, i) => (
        <li key={i} className="rc-hint">
          <Keys keys={h.keys} />
          {h.label}
        </li>
      ))}
      {trailing !== undefined && (
        <li className="rc-hint rc-hint--last">
          <Keys keys={trailing.keys} />
          {trailing.label}
        </li>
      )}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* ProgressBar                                                         */
/* ------------------------------------------------------------------ */

export interface ProgressBarProps {
  /** 0..1; clamped. null means unknown (an empty meter, no percentage). */
  value: number | null;
  /** Accessible name, e.g. "Export progress". */
  label: string;
  /** "large": the Export 44px percentage; "compact": one mono line; "bare": meter only. */
  size?: "large" | "compact" | "bare";
  /** Leading text for the compact head, e.g. "transcribing". */
  title?: ReactNode;
  /** Trailing text, e.g. "1:10 left". */
  detail?: ReactNode;
  /** Fill in the accent instead of ink. */
  accent?: boolean;
}

/** A thin meter, optionally with a percentage and time left. */
export function ProgressBar({
  value,
  label,
  size = "bare",
  title,
  detail,
  accent = false,
}: ProgressBarProps) {
  const v = value === null || Number.isNaN(value) ? null : Math.min(1, Math.max(0, value));
  const pct = v === null ? null : Math.round(v * 100);
  const meter = (
    <div
      className={cx("rc-meter", accent && "rc-meter--accent")}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
    >
      <i className="rc-meter__fill" style={{ width: `${pct ?? 0}%` }} />
    </div>
  );
  if (size === "large") {
    return (
      <div className="rc-progress">
        <div className="rc-pct">
          <span>{pct === null ? "…" : `${pct}%`}</span>
          {detail !== undefined && <small className="rc-pct__detail">{detail}</small>}
        </div>
        {meter}
      </div>
    );
  }
  if (size === "compact") {
    return (
      <div className="rc-progress rc-progress--compact">
        <div className="rc-progress__head">
          <span>
            {title !== undefined && <>{title} </>}
            {pct !== null && <b>{pct}%</b>}
          </span>
          {detail !== undefined && <span>{detail}</span>}
        </div>
        {meter}
      </div>
    );
  }
  return meter;
}

/* ------------------------------------------------------------------ */
/* Notice                                                              */
/* ------------------------------------------------------------------ */

export interface NoticeProps {
  children: ReactNode;
  /** "info" is polite; "warn" and "error" light the LED and are announced assertively. */
  tone?: "info" | "warn" | "error";
  /** When given, a flat "retry" key is shown. */
  onRetry?: () => void;
  retryLabel?: ReactNode;
  /** Keycap shown on the retry key. */
  retryShortcut?: string;
  className?: string;
}

/** A one-line notice, with an optional retry. */
export function Notice({
  children,
  tone = "info",
  onRetry,
  retryLabel = "retry",
  retryShortcut,
  className,
}: NoticeProps) {
  const loud = tone !== "info";
  const live = loud
    ? ({ role: "alert" } as const)
    : ({ role: "status", "aria-live": "polite" } as const);
  return (
    <div className={cx("rc-notice", `rc-notice--${tone}`, className)} {...live}>
      <Led on={loud} />
      <span className="rc-notice__text">{children}</span>
      {onRetry !== undefined && (
        <Button
          onClick={onRetry}
          {...(retryShortcut !== undefined ? { shortcut: retryShortcut } : {})}
        >
          {retryLabel}
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

export interface DialogProps {
  open: boolean;
  /** Short mono title, e.g. "export". Also the accessible name. */
  title: ReactNode;
  /** Keycap shown at the right of the title row, e.g. "ctrl e". */
  shortcut?: string;
  /** Footer content: usually a ShortcutBar or buttons. */
  footer?: ReactNode;
  /** "wide" for the shortcut overlay. */
  size?: "normal" | "wide";
  /** Called when the scrim (outside the dialog) is clicked. Esc handling belongs to `keys`. */
  onScrimClick?: () => void;
  /** Id for the title element; defaults to "rc-dialog-title". */
  titleId?: string;
  children?: ReactNode;
}

/** A modal panel over a scrim. Renders nothing when closed. */
export function Dialog({
  open,
  title,
  shortcut,
  footer,
  size = "normal",
  onScrimClick,
  titleId = "rc-dialog-title",
  children,
}: DialogProps) {
  if (!open) return null;
  return (
    <div
      className="rc-scrim"
      onClick={
        onScrimClick
          ? (e) => {
              if (e.target === e.currentTarget) onScrimClick();
            }
          : undefined
      }
    >
      <section
        className={cx("rc-dialog", size === "wide" && "rc-dialog--wide")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="rc-dialog__head">
          <h2 className="rc-dialog__title" id={titleId}>
            {title}
          </h2>
          {shortcut !== undefined && <Key>{shortcut}</Key>}
        </div>
        <div className="rc-dialog__body">{children}</div>
        {footer !== undefined && <div className="rc-dialog__foot">{footer}</div>}
      </section>
    </div>
  );
}

/** Label/value rows as in the Export confirm ("name", "save to"). */
export function InfoList({
  rows,
}: {
  rows: ReadonlyArray<{ label: ReactNode; value: ReactNode; action?: ReactNode }>;
}) {
  return (
    <dl className="rc-info">
      {rows.map((r, i) => (
        <div key={i} style={{ display: "contents" }}>
          <dt>{r.label}</dt>
          <dd>
            <span>{r.value}</span>
            {r.action}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------ */
/* ListRow (Home recent project)                                       */
/* ------------------------------------------------------------------ */

export interface ListRowProps extends Omit<LiHTMLAttributes<HTMLLIElement>, "onSelect"> {
  name: ReactNode;
  /** e.g. "41:12 kept of 1:04:30". */
  meta?: ReactNode;
  /** e.g. "edited 2 h ago". */
  stat?: ReactNode;
  selected?: boolean;
  onActivate?: () => void;
}

/** A recent-project row. Put rows inside <ListRows>. */
export function ListRow({
  name,
  meta,
  stat,
  selected = false,
  onActivate,
  className,
  ...rest
}: ListRowProps) {
  return (
    <li
      className={cx("rc-row", selected && "rc-row--on", className)}
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onActivate}
      {...rest}
    >
      <div className="rc-row__main">
        <div className="rc-row__name">{name}</div>
        {meta !== undefined && <div className="rc-row__meta">{meta}</div>}
      </div>
      {stat !== undefined && <div className="rc-row__stat">{stat}</div>}
    </li>
  );
}

/** The list that holds ListRows, with its "recent" heading. */
export function ListRows({
  heading,
  label = "Recent projects",
  children,
}: {
  heading?: ReactNode;
  label?: string;
  children: ReactNode;
}) {
  return (
    <div className="rc-recent">
      {heading !== undefined && <div className="rc-rhead">{heading}</div>}
      <ul className="rc-rows" role="listbox" aria-label={label}>
        {children}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* DropZone                                                            */
/* ------------------------------------------------------------------ */

export interface DropZoneProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: ReactNode;
  detail?: ReactNode;
  /** Usually the primary "pick footage" Button. */
  action?: ReactNode;
  /** True while a file is dragged over it. */
  active?: boolean;
}

/** The drop-footage panel on Home. Drag events are passed through as props. */
export function DropZone({
  title = "drop this week's footage",
  detail,
  action,
  active = false,
  className,
  ...rest
}: DropZoneProps) {
  return (
    <div
      className={cx("rc-oled", "rc-drop", active && "rc-drop--active", className)}
      data-active={active || undefined}
      {...rest}
    >
      <div className="rc-drop__mid">
        <svg
          className="rc-drop__art"
          viewBox="0 0 200 112"
          fill="none"
          stroke="var(--o-ink)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="74" y="4" width="52" height="62" rx="6" />
          <path d="M93 26l16 9-16 9z" />
          <path d="M100 76v18M92 87l8 8 8-8" stroke="var(--accent)" />
          <path d="M52 106h96" strokeWidth="4" />
        </svg>
        <h2 className="rc-drop__title">{title}</h2>
        {detail !== undefined && <p className="rc-drop__detail">{detail}</p>}
        {action}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SuggestionBlock chrome                                              */
/* ------------------------------------------------------------------ */

export interface SuggestionBlockProps {
  /** The suggested words (the view renders them; this only wraps them). */
  children: ReactNode;
  /** e.g. "retake" or "retake, said again at 0:24". */
  reason: ReactNode;
  /** e.g. "1 of 3". */
  position?: ReactNode;
  /** The suggestion the A / D keys act on: brighter bar, hints shown. */
  current?: boolean;
  /** Already accepted: text shown as cut. */
  accepted?: boolean;
  /** "bar": left accent bar (spec 1.7 C); "underline": dashed underline (HTML mockup). */
  marker?: "bar" | "underline";
  /** Hide the A / D hints (they show by default only on the current suggestion). */
  showHints?: boolean;
  acceptLabel?: ReactNode;
  dismissLabel?: ReactNode;
}

/** The chrome around a Claude suggestion: accent marker, reason line, A / D hints. */
export function SuggestionBlock({
  children,
  reason,
  position,
  current = false,
  accepted = false,
  marker = "bar",
  showHints,
  acceptLabel = "cut",
  dismissLabel = "keep",
}: SuggestionBlockProps) {
  const hints = showHints ?? current;
  return (
    <div
      className={cx(
        "rc-sug",
        marker === "bar" && "rc-sug--bar",
        current && "rc-sug--current",
        accepted && "rc-sug--accepted",
      )}
      data-current={current || undefined}
    >
      <span className={cx("rc-sug__text", marker === "underline" && "rc-sug__text--underline")}>
        {children}
      </span>
      <div className="rc-sug__why">
        <span>
          {reason}
          {position !== undefined && <> · {position}</>}
        </span>
        {hints && (
          <>
            <span className="rc-hint">
              <Key>a</Key>
              {acceptLabel}
            </span>
            <span className="rc-hint">
              <Key>d</Key>
              {dismissLabel}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* PauseChip                                                           */
/* ------------------------------------------------------------------ */

export interface PauseChipProps extends HTMLAttributes<HTMLSpanElement> {
  /** Pause length in seconds. */
  seconds: number;
  cut?: boolean;
  selected?: boolean;
  suggested?: boolean;
}

/** Formats a pause length the way the transcript shows it: "pause 3.1s". */
export function formatPause(seconds: number): string {
  const s = Math.max(0, seconds);
  return `pause ${s.toFixed(1)}s`;
}

/** An inline chip standing for a pause; it selects and cuts like a word. */
export function PauseChip({
  seconds,
  cut = false,
  selected = false,
  suggested = false,
  className,
  ...rest
}: PauseChipProps) {
  return (
    <span
      className={cx(
        "rc-pause",
        cut && "rc-pause--cut",
        selected && "rc-pause--sel",
        suggested && "rc-pause--sug",
        className,
      )}
      data-cut={cut || undefined}
      {...rest}
    >
      {formatPause(seconds)}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Empty and placeholder styles                                        */
/* ------------------------------------------------------------------ */

export interface EmptyStateProps {
  title: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** A centred empty state: one line of text, an optional detail and action. */
export function EmptyState({ title, detail, action, className }: EmptyStateProps) {
  return (
    <div className={cx("rc-empty", className)}>
      <p className="rc-empty__title">{title}</p>
      {detail !== undefined && <p className="rc-empty__detail">{detail}</p>}
      {action}
    </div>
  );
}

export interface PlaceholderProps {
  /** Mono text inside, e.g. "no video yet". */
  label?: ReactNode;
  /** "video" keeps a 16:9 box (player before the proxy exists). */
  shape?: "fill" | "video";
  className?: string;
}

/** A dark oled box standing in for content that is not ready. */
export function Placeholder({ label, shape = "fill", className }: PlaceholderProps) {
  return (
    <div
      className={cx(
        "rc-oled",
        "rc-placeholder",
        shape === "video" && "rc-placeholder--video",
        className,
      )}
    >
      {label !== undefined && <span>{label}</span>}
    </div>
  );
}

/** Grey bars standing in for lines of text not yet transcribed. */
export function SkeletonLines({ widths = [92, 78, 85] }: { widths?: readonly number[] }) {
  return (
    <span aria-hidden="true">
      {widths.map((w, i) => (
        <span key={i} className="rc-skeleton" style={{ width: `${w}%` }} />
      ))}
    </span>
  );
}

/** A small mono label, e.g. "confirm", "running", "done". */
export function Label({ children }: { children: ReactNode }) {
  return <span className="rc-lbl">{children}</span>;
}

/** A dark "oled" panel (player, strip, timeline, drop zone). */
export function Oled({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("rc-oled", className)} {...rest} />;
}
