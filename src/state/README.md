# `state`: the store the screens read

One zustand store holds everything the screens show. Screens **read** it with hooks and **act**
by dispatching actions. They never call `edit`, `transcript`, the player or the core (spec 3.6
rule 1). The keyboard and the mouse go through the same `dispatch(actionId, payload?)`.

Import everything from `src/state` (`import { useRoughcut, useDispatch } from "../../state"`).

## Reading the store and dispatching an action

```tsx
import { selectSequenceDuration, useDispatch, useRoughcut } from "../../state";

export function KeptLength() {
  const kept = useRoughcut(selectSequenceDuration);      // re-renders only when it changes
  const view = useRoughcut((s) => s.session.view);
  const dispatch = useDispatch();
  return (
    <button type="button" onClick={() => void dispatch("everywhere.switchView")}>
      {view} · {kept / 1_000_000}s kept
    </button>
  );
}

// A mouse action with a payload:
dispatch("ui.placeCaret", { boundary: 42 });
dispatch("ui.trimEdgeTo", { clipId: "clip-3", edge: "end", to: 12_345_678 });
```

`dispatch` returns a promise that resolves when the action's work (including core calls) is done.
Edits are applied before it returns, so a view never waits for one. Errors become notices; the
promise never rejects.

Hooks (`react.tsx`):

| Hook | Use |
| --- | --- |
| `useRoughcut(selector)` | Read a slice; compared with `Object.is`. Use the exported selectors or pick fields. |
| `useRoughcutShallow(selector)` | Read a selector that builds a new object or array each time (shallow compare). |
| `useDispatch()` | The dispatcher. |
| `useRoughcutStore()` | The store itself, e.g. `store.getState()` inside an event handler. |
| `usePlayerAttach()` | The `onPlayer` callback for `PlayerView` (see below). |
| `useVisualLinesRegistration()` | The Transcript view registers its visual lines for Up / Down by line. |

`RoughcutProvider` puts a store in context; `App.tsx` does this.

## The state (`types.ts`, `RoughcutState`)

| Field | What it is |
| --- | --- |
| `ready` | Settings and the project list have loaded. |
| `screen` | `"home"` or `"editor"`. |
| `dialogs.export` | `ExportDialogState` or null. `phase` is `"confirm"`, `"running"` or `"done"`; also `folder`, `fileName`, `plan` (`ExportPlan`, null while `planning`), `error` (`AppError`: a failed plan, start or job), `jobId`, `progress` (0 to 1), `secondsLeft`, `result` (`ExportResult`), `copied`. A plan with `blockedBy` (nothing kept, disk full, source missing) cannot start: show `plan.blockedBy.message`. |
| `dialogs.shortcuts` | The `?` overlay is open. |
| `dialogs.locate` | `LocatePromptState` or null: `sourceId`, `path`, `name`, `error` (`source_mismatch` = a different file), `busy`. |
| `projects`, `homeSelection` | Home rows (`ProjectSummary[]`, most recent first) and the selected row. |
| `busy` | A short label while a project is being opened or created, else null. |
| `project` | The open `Project`. Its `sources`, `name` and `lastExport` are current; its `edit` and `session` are **not**: read `edit` and `session`. |
| `edit` | The `EditDocument` (clips in playing order, dismissed ranges, undo and redo). |
| `session` | `SessionState`: `view`, `playhead`, `playbackRate`, `cutTextHidden`. |
| `sources[id]` | `SourceEntry`: `assets` (`SourceAssets`), `transcript` (grows as it streams), `suggestions` (`SuggestionSet`), `suggestionsError`. |
| `jobs[id]` | Every `JobStatus` the core reported. |
| `notices` | One-line notices `{ id, kind: "info" \| "warning" \| "error", text, retry? }`. A `retry` button dispatches `retry.action` with `retry.payload`; a close button dispatches `ui.dismissNotice`. |
| `layout` | The `TranscriptLayout` (from `transcript`) for the current edit: blocks, display tokens, suggestion views. Null with no project. |
| `selection` | Caret and selection as boundaries in `layout` (`{ anchor, focus }`; collapsed = caret). |
| `playhead` | `{ time, position, playing, speed }`. The caret and the playhead are the same thing. |
| `marks` | `{ in, out }` set with `I` / `O` (source positions, or sequence times). |
| `find` | `{ open, query, matches, index, focusRequest }`. Focus the find box whenever `focusRequest` changes. |
| `currentSuggestion` | The suggestion `N` / `Shift+N` last landed on. |
| `zoom` | Timeline zoom: 1 = fit everything, each zoom in doubles it, up to `ZOOM_MAX`. |
| `claude`, `settings`, `keymap`, `rebindError` | Claude's status, the `Settings`, the keymap in force (defaults plus `settings.keyBindings`), why the last rebind was refused. |
| `save` | `{ pending, saving, lastSavedAt, error }`. |
| `buffering`, `playerError` | From the player. |

## Selectors (`selectors.ts`)

All take the whole state and return the same object while their inputs are the same.

| Selector | Returns |
| --- | --- |
| `selectKeyScope` | The scope for `attachKeys`: `"everywhere"` while the `?` overlay is open (even over the Export dialog); else `{ context: "export", phase }` while the Export dialog is open; else `"everywhere"` while the Locate file prompt is open (both are modal for keys: view keys such as Delete do nothing behind them); else `"home"`, `"transcript"` or `"timeline"`. |
| `selectHintScreen` | The `HintScreen` for `screenHints(keymap, ...)` in `keys`. |
| `selectClips`, `selectSequenceDuration`, `selectCutPoints` | The clip list, its length ("41:12 kept"), every cut point. |
| `selectCurrentClip` | The `PlacedClip` under the playhead (the highlighted clip). |
| `selectCutCounter` | `{ index, count }` for "cut 2 of 14". |
| `selectCanUndo`, `selectCanRedo` | Booleans. |
| `selectProjectSources` | `{ ref: SourceRef, entry: SourceEntry \| null }[]` in project order. |
| `selectMissingSources` | The `SourceRef`s whose file is missing. |
| `selectWaveformUrls` | `waveformUrl` per source id (use it as given, no headers). |
| `selectProjectJobs` | Jobs of the open project. |
| `selectTranscribing` | `{ progress, secondsLeft, sources }` while a transcript is incomplete, else null (the progress line of spec 1.7 B). |
| `selectPendingSuggestions` | Pending `SuggestionView`s ("3 suggestions"). |
| `selectActiveSuggestion` | The suggestion `A` / `D` act on, or null. |
| `selectSelectedRanges` | Source ranges of the selection (the "Selection" panel). |
| `selectCaretPosition` | The caret's `SourcePosition` ("TAKE-1.mp4 at 0:27.4"). |
| `selectCaption` | The Timeline view's caption around the playhead (`Caption`), or null. |
| `selectNothingKept` | True when every clip is gone (export disabled with a note). |
| `selectSelectedProject` | The selected Home row. |

## Actions

Every id in `KEY_ACTIONS` (`src/keys/actions.ts`) has a handler; a test checks it. Two key actions
also take an optional payload from a button: `transcript.acceptSuggestion` and
`transcript.dismissSuggestion` take `{ suggestionId }` (the block's "A cut" / "D keep").
Other buttons dispatch the key action itself: the Export button is `everywhere.export`, the
dialog's Export is `export.confirm`, Cancel is `export.cancel`, Change is `export.changeFolder`,
Show in folder `export.showInFolder`, Copy path `export.copyPath`, Close `export.close`.

Mouse actions with no key (`UiActionPayloads` in `types.ts`, ids in `UI_ACTION_IDS`):

| Action | Payload | Does |
| --- | --- | --- |
| `ui.placeCaret` | `{ boundary, extend? }` | Click in the transcript: caret there (Shift extends); the playhead follows. |
| `ui.selectTokens` | `{ anchorToken, focusToken }` | Drag across words: whole tokens, both ends included. |
| `ui.seek` | `{ time }` | Click on the timeline or overview: playhead (and caret) to a sequence time. |
| `ui.trimEdgeTo` | `{ clipId, edge, to }` | Drag a clip edge to a source time. One undo step. |
| `ui.moveClipTo` | `{ clipId, index }` | Drag a clip to a position in the sequence. One undo step. |
| `ui.dropFiles` | `{ paths }` | Dropped files: new project on Home, added footage in the editor. |
| `ui.selectProject` / `ui.openProject` / `ui.removeProject` | `{ index }` / `{ projectId }` / `{ projectId }` | Home rows. |
| `ui.renameProject` | `{ projectId?, name }` | Rename (the open project by default). |
| `ui.goHome` | none | Save, close the project, show Home. |
| `ui.setView` | `{ view }` | The view switch. |
| `ui.setRate` | `{ rate }` | 1, 1.5 or 2. |
| `ui.findQuery` | `{ query }` | Typing in the find box: searches and jumps to the first match from the caret. |
| `ui.findNext` / `ui.findPrevious` | none | Enter / Shift+Enter in the find box (the keys module leaves these to the field). |
| `ui.findClose` | none | Closes the find box (Esc does too). |
| `ui.selectSuggestion` | `{ suggestionId }` | Click a suggestion block. |
| `ui.retryClaude` | `{ sourceId? }` or none | The Claude notice's Retry. |
| `ui.retrySave` | none | The save notice's Retry. |
| `ui.dismissNotice` | `{ id }` | Close a notice. |
| `ui.locateSource` | `{ sourceId? }` or none | Pick the file for a missing source (the prompt's by default). |
| `ui.closeLocate` | none | Close the prompt for this session. |
| `ui.exportFileName` | `{ fileName }` | Edit the export name (plans again). |
| `ui.setZoom` | `{ zoom }` | Scroll to zoom (1 = fit). |
| `ui.cancelJob` | `{ jobId }` | Cancel any job. |
| `ui.rebindKey` / `ui.resetKey` / `ui.resetAllKeys` | `{ actionId, chord }` / `{ actionId }` / none | Change shortcuts; saved to Settings, used at once. A refused clash lands in `rebindError`. |
| `ui.closeShortcuts` | none | Close the `?` overlay. |

While the Export dialog is open, only `export.*`, `everywhere.showShortcuts`, `everywhere.escape`,
the dialog's own mouse actions and a notice's Retry act.

The Locate file prompt works from the keyboard: `attachStoreKeys` turns Enter (`LOCATE_CHORD`,
exported from the index) into `ui.locateSource` while `dialogs.locate` is open, and Esc
(`everywhere.escape`) closes it. The prompt should show "Enter Locate…" and "Esc Not now" as hints.

## What each screen receives

None of the screens takes props: each reads the store.

| Component | File | Reads |
| --- | --- | --- |
| `HomeScreen` | `src/views/home/index.tsx` | `projects`, `homeSelection`, `busy`, `notices`. Drop zone: `ui.dropFiles`. |
| `EditorScreen` | `src/views/editor/index.tsx` | `project`, `session.view`, `playhead`, `save`. Renders `TranscriptView` or `TimelineView` and hosts the player: `<PlayerView onPlayer={usePlayerAttach()} />`. |
| `TranscriptView` | `src/views/transcript/index.tsx` | `layout`, `selection`, `marks`, `find`, `currentSuggestion`, `selectTranscribing`. Registers its lines with `useVisualLinesRegistration()` (and null on unmount). |
| `TimelineView` | `src/views/timeline/index.tsx` | `edit`, `playhead`, `zoom`, `selectCurrentClip`, `selectCaption`, `selectWaveformUrls`. |
| `ExportDialog` | `src/views/export/index.tsx` | `dialogs.export`; renders nothing when null. |
| `ShortcutOverlay` | `src/views/overlays/index.tsx` | `dialogs.shortcuts`, `keymap` (`shortcutGroups(keymap)` from `keys`). |
| `LocateFilePrompt` | `src/views/overlays/index.tsx` | `dialogs.locate`. |
| `Notices` | `src/views/overlays/index.tsx` | `notices`. |

The player: only one `PlayerView` should be mounted at a time. When it mounts, the store loads it
with the clips and addresses, sets the rate and seeks to the playhead; when it unmounts (the hook
passes null), the store keeps the playhead itself.

## Behaviour worth knowing

- **Caret = playhead.** Moving the caret seeks the player to where the token at the caret plays.
  While playing, a collapsed caret follows playback. Timeline steps, jumps and clicks move the caret
  to the token under the playhead.
- **Cut and restore** act on the selection; with nothing selected, on the `I` / `O` marks when both
  are set; otherwise on the word at the caret.
- **Autosave**: `save_edit` runs 300 ms after an edit (several quick edits are written together)
  and 2 s after a change of view, rate or playhead alone. `flushSave()` runs on page hide. In the
  app window, closing the window waits (up to 3 s, `CLOSE_SAVE_LIMIT_MS`) for
  `store.prepareToClose()` (pause, then save until nothing is left), through the optional
  `CoreClient.onCloseRequested`: a save started from `pagehide` never reached the core.
  Opening, creating or leaving a project saves the open one before the call and again right
  before the new one replaces it, so edits made while it loads are kept. If that save fails, the
  open project stays on screen with a "Could not save" notice and its Retry.
- **Export cancel**: Esc while the export is still starting closes the dialog at once; the job is
  cancelled as soon as `start_export` answers, and its events are ignored.
- **Player notice**: the "Playback did not start" notice goes away as soon as playback runs.
- **Events** from the core are kept for every source, even one not in the open project yet.

- **One open or import at a time**: `busy` is set the moment an open or import starts (before
  the old project is saved). While it is set, Enter on Home, Ctrl+N, a window drop and a row
  double-click start nothing.
- **Locate runs once**: while a locate is running (picker open, then the core's check), Enter or
  a click on "locate…" does nothing.
- **Notices over the Export dialog**: a notice's Retry (`ui.retry*`, or whatever action a notice
  on screen offers) still acts while the Export dialog is open.
- **The `?` overlay over the Export dialog** takes the key scope (`"everywhere"`): the dialog's
  keys (Enter, C) do nothing behind it; Esc closes the overlay only.
- **Mixed formats**: the "These recordings differ in format" notice appears on create, on add and
  again whenever such a project is reopened.
- **Disk space**: `requiredBytesOf(plan)` (from `state`) reads the plan's optional
  `requiredBytes`; the Export dialog shows "Needs about X · Y free" only when it is there.

## Which core: Tauri or the stand-in

`coreKind()` in `src/state/core/index.ts` is the one place that decides: inside the Tauri window
the real core (`tauriCore`), anywhere else (a plain browser with `npm run dev`, Vitest) the
in-memory stand-in with its demo data. `src/main.tsx` starts the app through `bootRoughcut()`
(`src/app/boot.ts`), which shows the choice on `<html data-core="tauri|standin">`, in
`window.__roughcut.core` and once in the browser console.

In a plain browser the stand-in's jobs run on a clock that follows real time, and its media come
from `src/app/demoMedia.ts`: video is `fixtures/out/speech-2min.mp4` served by the dev server
(make it with `npm run fixtures`; it is about 2 minutes long, the demo about 12, so past its end
the player shows its last frame), waveforms are made from the demo transcript.

## `window.__roughcut` (every build)

| Field | What it is |
| --- | --- |
| `core` | `"tauri"` or `"standin"`. |
| `store`, `dispatch(actionId, payload?)`, `getState()` | The store, to drive the app from outside (e.g. Playwright's `page.evaluate`). |
| `scenario`, `scenarios` | The scenario from the address, and every scenario name (stand-in only). |
| `scenarioReady` | True once the store has loaded and the scenario is set up. `scripts/screenshot.mjs` waits for it. |
| `scenarioError` | Why the scenario failed (also shown as a notice), or null. |
| `standin` | Stand-in only: the `StandinCore` (`setErrors`, `failNext`, ...). |
| `clock` | Stand-in only: `pause()`, `resume()`, `advance(ms)`, `running` for the stand-in's jobs. |

## Address scenarios (browser, stand-in core)

`http://127.0.0.1:1420/?scenario=<name>` (with `npm run dev`) puts the app in a given state through
the same actions a user would take. A scenario is a still: the stand-in's clock stays stopped
afterwards unless the address also has `&live=1`. Defined in `src/app/scenarios.ts`; checked by
`src/app/boot.test.ts`.

| Name | On screen |
| --- | --- |
| (none) | Home with the demo project; jobs run in real time. |
| `home` | Home with three projects, the most recent selected. |
| `home-empty` | Home with no projects yet. |
| `transcribing` | Editor right after a drop: the transcript is still arriving (progress line, arriving block). |
| `transcript` | Transcript view: one take cut (struck through), the next suggestion current. |
| `find` | Transcript view, find box open on "first thing", landed on a match inside cut text (hiding turned off). |
| `timeline` | Timeline view after accepting the suggestions, playhead on the second cut. |
| `export-confirm` | Export dialog, confirm stage. |
| `export-running` | Export dialog, running stage (about half way). |
| `export-done` | Export dialog, done stage. |
| `export-disk-full` | Export blocked: not enough disk space, with the amount needed. |
| `export-nothing` | Export blocked: everything is cut. |
| `export-missing` | Export blocked: a source file is missing. |
| `export-failed` | Export dialog back at confirm after the export could not start. |
| `export-shortcuts` | The `?` overlay over the Export dialog. |
| `shortcuts` | The `?` overlay over the Transcript view. |
| `locate` | The Locate file prompt (the recording was moved). |
| `notice` | A one-line notice with Retry (Claude signed out). |
| `mixed` | Two recordings in different formats, with the mixed-format notice. |

Screenshots: with `npm run dev` running,
`node scripts/screenshot.mjs "http://127.0.0.1:1420/?scenario=timeline" out.png [1440x900] [--wait MS] [--strict]`
(installed Microsoft Edge, headless; prints console errors and warnings; `--strict` exits 2 on an error).

## Making a store (tests and previews)

```ts
import { createStandinCore } from "./core";
import { createRoughcutStore } from "./store";
import { FakePlayer, createTestRig, pressKey } from "./testing"; // src/state/testing.ts, not re-exported from the index

const { store, core, player } = createTestRig({ stepMs: 100 });   // stand-in core + FakePlayer
await store.init();
await store.dispatch("ui.openProject", { projectId: core.demo.projectId });
player.advance(1000);                                              // play on for a second

// Or by hand, with any CoreClient and any PlayerLike:
const custom = createRoughcutStore({ core: createStandinCore(), player: new FakePlayer(), autosaveMs: 300 });
```

`attachStoreKeys(store, window)` connects the real key listener; `pressKey("Ctrl+Z")` sends a
keystroke in a test. `store.idle()` waits for every action and save in flight.
