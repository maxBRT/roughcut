/**
 * Starting the app: which core it talks to, the store, `window.__roughcut`, and (in a plain
 * browser) the scenario named in the address.
 *
 * - Inside the Tauri window: the real core (`tauriCore`).
 * - In a plain browser (`npm run dev`): the stand-in core with its demo data, its jobs driven by
 *   a clock that follows real time, and media from `demoMedia.ts`. `?scenario=<name>` puts the
 *   app in a given state (see `scenarios.ts` and src/state/README.md).
 *
 * The choice is `coreKind()` (src/state/core/index.ts). It is shown on `<html data-core>`, in
 * `window.__roughcut.core` and once in the console.
 */
import { createRoughcutStore, type Dispatch, type RoughcutState, type RoughcutStore } from "../state";
import {
  coreKind,
  createStandinCore,
  createTauriCore,
  ManualScheduler,
  type CoreKind,
  type StandinCore,
} from "../state/core";
import { browserDemoMediaUrl } from "./demoMedia";
import { SCENARIOS, SCENARIO_NAMES, type ScenarioContext } from "./scenarios";

/** The stand-in core's clock in a plain browser. */
export interface DemoClock {
  /** True while jobs follow real time. */
  readonly running: boolean;
  pause(): void;
  resume(): void;
  /** Runs the jobs for `ms` of their time at once (works while paused). */
  advance(ms: number): void;
}

/** What `window.__roughcut` holds, in every build. */
export interface RoughcutHandle {
  /** The core in use. */
  readonly core: CoreKind;
  readonly store: RoughcutStore;
  readonly dispatch: Dispatch;
  getState(): RoughcutState;
  /** The scenario from the address, or null. */
  readonly scenario: string | null;
  /** Every scenario name (stand-in only; they need the stand-in core). */
  readonly scenarios: readonly string[];
  /** True once the store has loaded and the address's scenario (if any) is set up. */
  scenarioReady: boolean;
  /** Why the scenario could not be set up, or null. */
  scenarioError: string | null;
  /** The stand-in core (to inject errors, etc.), in a plain browser only. */
  readonly standin?: StandinCore;
  /** The stand-in core's clock, in a plain browser only. */
  readonly clock?: DemoClock;
}

declare global {
  interface Window {
    __roughcut?: RoughcutHandle;
  }
}

/** A ManualScheduler that follows real time while running. */
function createDemoClock(scheduler: ManualScheduler): DemoClock {
  let timer: ReturnType<typeof setInterval> | null = null;
  let last = 0;
  const tick = () => {
    const now = performance.now();
    scheduler.advance(now - last);
    last = now;
  };
  return {
    get running() {
      return timer !== null;
    },
    pause() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    resume() {
      if (timer !== null) return;
      last = performance.now();
      timer = setInterval(tick, 50);
    },
    advance(ms) {
      scheduler.advance(ms);
    },
  };
}

/** The scenario named in the address (`?scenario=`), or null. */
export function scenarioFromAddress(search: string): string | null {
  const name = new URLSearchParams(search).get("scenario");
  return name && name.trim() !== "" ? name.trim() : null;
}

/** Makes the store on the right core and publishes `window.__roughcut`. */
export function bootRoughcut(win: Window = window): RoughcutHandle {
  const kind = coreKind();
  win.document.documentElement.dataset.core = kind;
  if (kind === "tauri") {
    const store = createRoughcutStore({ core: createTauriCore() });
    const handle: RoughcutHandle = {
      core: kind,
      store,
      dispatch: store.dispatch,
      getState: () => store.getState(),
      scenario: null,
      scenarios: [],
      scenarioReady: false,
      scenarioError: null,
    };
    win.__roughcut = handle;
    void store.init().then(() => {
      handle.scenarioReady = true;
    });
    return handle;
  }

  const scenarioName = scenarioFromAddress(win.location.search);
  const scenario = scenarioName ? SCENARIOS[scenarioName] : undefined;
  const scheduler = new ManualScheduler();
  const clock = createDemoClock(scheduler);
  let fixedNow: Date | null = null;
  const standin = createStandinCore({
    scheduler,
    seedDemo: scenario?.seedDemo ?? true,
    mediaUrl: browserDemoMediaUrl,
    now: () => fixedNow ?? new Date(),
  });
  const store = createRoughcutStore({ core: standin });
  const handle: RoughcutHandle = {
    core: kind,
    store,
    dispatch: store.dispatch,
    getState: () => store.getState(),
    scenario: scenarioName,
    scenarios: SCENARIO_NAMES,
    scenarioReady: false,
    scenarioError: null,
    standin,
    clock,
  };
  win.__roughcut = handle;
  console.info(
    `Roughcut: stand-in core with demo data (plain browser).${scenarioName ? ` Scenario: ${scenarioName}.` : ""} window.__roughcut has the store.`,
  );

  const ctx: ScenarioContext = {
    store,
    core: standin,
    advance: async (ms) => {
      scheduler.advance(ms);
      await store.idle();
    },
    finishJobs: async () => {
      scheduler.runAll();
      await store.idle();
    },
    setNow: (date) => {
      fixedNow = date;
    },
  };

  const setUp = async () => {
    if (scenarioName && !scenario) {
      throw new Error(`Unknown scenario "${scenarioName}". Known: ${SCENARIO_NAMES.join(", ")}.`);
    }
    if (scenario?.prepare) await scenario.prepare(ctx);
    await store.init();
    if (scenario?.run) await scenario.run(ctx);
    await store.idle();
  };
  void setUp()
    .catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      handle.scenarioError = message;
      console.error(`Roughcut: ${message}`);
      store.setState({ notices: [...store.getState().notices, { id: "scenario", kind: "error", text: message }] });
    })
    .finally(() => {
      // A scenario is a still: its clock stays stopped unless the address says `live=1`.
      if (!scenarioName || new URLSearchParams(win.location.search).get("live") === "1") clock.resume();
      handle.scenarioReady = true;
    });
  return handle;
}
