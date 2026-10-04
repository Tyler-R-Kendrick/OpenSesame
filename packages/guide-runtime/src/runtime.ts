/**
 * The deterministic GuideLang state machine.
 *
 * It owns exactly one trajectory at a time, drives it through the ports, and
 * settles on a `GuideOutcome` the support layer can replan from. It has no
 * DOM, no router and no timer of its own — every deadline comes from the
 * injected `GuideClock`, so a test can drive a whole guide without sleeping.
 */

import type {
  GuideGoalId,
  GuideLimits,
  GuideProgram,
} from "@opensesame/guide-lang";

import { runAuto } from "./auto.js";
import { checkProgram, validationError } from "./check.js";
import { GUIDE_RUNTIME_NOTES } from "./notes.js";
import type {
  GuideCancelReason,
  GuideOutcome,
  GuideRunMode,
  GuideRunOptions,
  GuideRuntime,
  GuideRuntimeError,
  GuideRuntimeObserver,
  GuideRuntimePorts,
  GuideRuntimeSnapshot,
  GuideRuntimeStatus,
  GuideTourView,
} from "./ports.js";
import {
  type TourCommand,
  type TourHost,
  postTourCommand,
  runTour,
} from "./tour.js";

export { GUIDE_RUNTIME_NOTES };

const IDLE_SNAPSHOT: GuideRuntimeSnapshot = {
  status: "idle",
  goal: null,
  index: 0,
  total: 0,
  runId: 0,
  message: null,
  error: null,
  tour: null,
};

type ActiveRun = {
  readonly id: number;
  readonly goal: GuideGoalId;
  readonly controller: AbortController;
  readonly settle: (outcome: GuideOutcome) => void;
  readonly total: number;
  settled: boolean;
  index: number;
  message: string | null;
  readonly mode: GuideRunMode;
  readonly limits: GuideLimits | undefined;
  wake: ((command: TourCommand) => void) | null;
};

export function createGuideRuntime(ports: GuideRuntimePorts): GuideRuntime {
  const observers = new Set<GuideRuntimeObserver>();
  let latest: GuideRuntimeSnapshot = IDLE_SNAPSHOT;
  let active: ActiveRun | null = null;
  let latestRunId = 0;

  function notify(
    observer: GuideRuntimeObserver,
    next: GuideRuntimeSnapshot,
  ): void {
    try {
      observer.onSnapshot(next);
    } catch {
      // A subscriber that throws must not be able to break the trajectory it
      // is only watching.
    }
  }

  function publish(next: GuideRuntimeSnapshot): void {
    latest = next;
    for (const observer of [...observers]) notify(observer, next);
  }

  function publishRun(
    run: ActiveRun,
    status: GuideRuntimeStatus,
    error: GuideRuntimeError | null,
    tour: GuideTourView | null = null,
  ): void {
    publish({
      status,
      goal: run.goal,
      index: run.index,
      total: run.total,
      runId: run.id,
      message: run.message,
      error,
      tour,
    });
  }

  function settleRun(run: ActiveRun, outcome: GuideOutcome): void {
    if (run.settled) return;
    run.settled = true;
    run.controller.abort();
    if (active === run) active = null;
    run.settle(outcome);
  }

  function failRun(run: ActiveRun, error: GuideRuntimeError): void {
    // A run that already settled keeps its outcome: a late failure belongs to
    // nobody, and publishing it would stamp a stale run over the live one.
    if (run.settled) return;
    publishRun(run, "failed", error);
    settleRun(run, { kind: "failed", goal: run.goal, error });
  }

  /**
   * Every continuation re-asks this before it renders, mutates the snapshot or
   * settles. A run that was superseded or cancelled while awaiting must leave
   * no trace on the run that replaced it.
   */
  function isLive(run: ActiveRun): boolean {
    return run.id === latestRunId && !run.settled;
  }

  /** What a tour needs of the runtime, bound to the run it is walking. */
  function tourHost(run: ActiveRun): TourHost {
    return {
      ports,
      isLive,
      publish: (target, status, tour, index) => {
        if (target !== run) return;
        run.index = index;
        // What a tour leaves behind for the transcript is its closing
        // sentence, and only that: a step is already on the card.
        if (tour) run.message = tour.kind === "close" ? tour.message : null;
        publishRun(run, status, null, tour);
      },
      settle: (target, outcome) => {
        if (target === run) settleRun(run, outcome);
      },
      fail: (target, error) => {
        if (target === run) failRun(run, error);
      },
    };
  }

  async function execute(run: ActiveRun, program: GuideProgram): Promise<void> {
    try {
      const invalid = checkProgram(ports, program, run.limits);
      if (invalid !== null) {
        failRun(run, invalid);
      } else if (run.mode === "tour") {
        await runTour(tourHost(run), run, program);
      } else {
        await runAuto(
          { ports, isLive, publishRun, failRun, settleRun },
          run,
          program,
        );
      }
    } catch {
      // A port that throws is a defect on our side of the boundary, but the
      // caller is awaiting an outcome: settle rather than reject.
      failRun(run, validationError("runtime"));
    }
  }

  function start(
    program: GuideProgram,
    options: GuideRunOptions = {},
  ): Promise<GuideOutcome> {
    const superseded = active;
    if (superseded !== null) {
      publishRun(superseded, "done", null);
      settleRun(superseded, {
        kind: "cancelled",
        goal: superseded.goal,
        reason: "superseded",
      });
    }
    latestRunId += 1;
    let settle: (outcome: GuideOutcome) => void = () => {};
    const outcome = new Promise<GuideOutcome>((resolve) => {
      settle = resolve;
    });
    const run: ActiveRun = {
      id: latestRunId,
      goal: program.goal,
      controller: new AbortController(),
      settle,
      total: program.instructions.length,
      settled: false,
      index: 0,
      message: null,
      mode: options.mode ?? "auto",
      limits: options.limits,
      wake: null,
    };
    active = run;
    void execute(run, program).catch(() => {
      // `execute` is guarded end to end; this exists so that no defect can
      // surface as an unhandled rejection or as a promise that never settles.
      failRun(run, validationError("runtime"));
    });
    return outcome;
  }

  function command(next: TourCommand): void {
    if (active !== null && active.mode === "tour")
      postTourCommand(active, next);
  }

  function pause(): void {
    const run = active;
    if (run === null) return;
    publishRun(run, "paused", null);
    settleRun(run, { kind: "paused", goal: run.goal });
  }

  function cancel(reason: GuideCancelReason): void {
    // A lock tears the overlays down whatever the runtime is doing, including
    // when the last run left them up by pausing.
    if (reason === "lock") ports.renderer.clear();
    const run = active;
    if (run === null) {
      if (reason === "lock" && latest.status === "paused") {
        publish({ ...latest, status: "done" });
      }
      return;
    }
    publishRun(run, "done", null);
    settleRun(run, { kind: "cancelled", goal: run.goal, reason });
  }

  return {
    start,
    next: () => command("next"),
    back: () => command("back"),
    restart: () => command("restart"),
    pause,
    cancel,
    snapshot: () => latest,
    subscribe: (observer) => {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
  };
}
