/**
 * The deterministic GuideLang state machine.
 *
 * It owns exactly one trajectory at a time, drives it through the ports, and
 * settles on a `GuideOutcome` the support layer can replan from. It has no
 * DOM, no router and no timer of its own — every deadline comes from the
 * injected `GuideClock`, so a test can drive a whole guide without sleeping.
 */

import {
  GUIDE_LANG_VERSION,
  GUIDE_LIMITS,
  countGuideTextCharacters,
  hasForbiddenTextCharacter,
  isGuideGoalId,
  isGuidePredicateId,
  isGuideRouteId,
  isGuideSide,
  isGuideTargetId,
  isGuideWaitEvent,
  isTerminalInstruction,
} from "@opensesame/guide-lang";
import type {
  AnnotateInstruction,
  FocusInstruction,
  GuideGoalId,
  GuideInstruction,
  GuidePredicateId,
  GuideProgram,
  GuideRouteId,
  GuideSide,
  GuideTargetId,
  HintInstruction,
  WaitInstruction,
} from "@opensesame/guide-lang";

import type {
  GuideCancelReason,
  GuideFocusRequest,
  GuideOutcome,
  GuideRuntime,
  GuideRuntimeError,
  GuideRuntimeObserver,
  GuideRuntimePorts,
  GuideRuntimeSnapshot,
  GuideRuntimeStatus,
  GuideScrollRequest,
} from "./ports.js";

/**
 * The closed set of semantic notes an `observed` outcome may carry. The note
 * says why the trajectory stopped; it is written here, never by a model, so
 * the support layer can branch on it without parsing prose.
 */
export const GUIDE_RUNTIME_NOTES = {
  /** Ran off the end of the trajectory — the replan boundary. */
  exhausted: "trajectory exhausted",
  waitSatisfied: "wait satisfied",
  /** A wait port rejected outside a cancellation: nothing left to observe. */
  unobservable: "wait unobservable",
} as const;

const IDLE_SNAPSHOT: GuideRuntimeSnapshot = {
  status: "idle",
  goal: null,
  index: 0,
  total: 0,
  runId: 0,
  message: null,
  error: null,
};

type PointingInstruction =
  | AnnotateInstruction
  | FocusInstruction
  | HintInstruction;

type ActiveRun = {
  readonly id: number;
  readonly goal: GuideGoalId;
  readonly controller: AbortController;
  readonly settle: (outcome: GuideOutcome) => void;
  readonly total: number;
  settled: boolean;
  index: number;
  message: string | null;
};

type WaitResolution = "aborted" | "observed" | "timeout";

function validationError(detail: string): GuideRuntimeError {
  return { code: "GUIDE_VALIDATION_ERROR", detail };
}

function checkMessage(message: string): GuideRuntimeError | null {
  // Code points, matching the parser. Counting UTF-16 units here rejected
  // astral text the compiler had already accepted.
  if (countGuideTextCharacters(message) > GUIDE_LIMITS.maxMessageChars) {
    return validationError("maxMessageChars");
  }
  if (hasForbiddenTextCharacter(message)) {
    return validationError("forbiddenTextCharacter");
  }
  return null;
}

function checkSide(side: GuideSide | null): GuideRuntimeError | null {
  return side === null || isGuideSide(side) ? null : validationError("side");
}

/**
 * A syntactically invalid identifier fails as a validation error rather than
 * an unknown one: `detail` reaches logs and the support transcript, and only
 * a string that already matched the semantic-id grammar is safe to put there.
 * Anything else is still model-authored text.
 */
function checkTarget(
  ports: GuideRuntimePorts,
  target: GuideTargetId,
): GuideRuntimeError | null {
  if (!isGuideTargetId(target)) return validationError("target");
  if (!ports.targets.isKnown(target)) {
    return { code: "UNKNOWN_TARGET", detail: target };
  }
  return null;
}

function checkRoute(
  ports: GuideRuntimePorts,
  route: GuideRouteId,
): GuideRuntimeError | null {
  if (!isGuideRouteId(route)) return validationError("route");
  if (!ports.routes.isKnown(route)) {
    return { code: "UNKNOWN_ROUTE", detail: route };
  }
  return null;
}

function checkPredicate(
  ports: GuideRuntimePorts,
  predicate: GuidePredicateId,
): GuideRuntimeError | null {
  if (!isGuidePredicateId(predicate)) return validationError("predicate");
  if (!ports.state.isKnown(predicate)) {
    return { code: "UNKNOWN_PREDICATE", detail: predicate };
  }
  return null;
}

function checkWait(
  ports: GuideRuntimePorts,
  instruction: WaitInstruction,
): GuideRuntimeError | null {
  const { timeoutMs } = instruction;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < GUIDE_LIMITS.minTimeoutMs ||
    timeoutMs > GUIDE_LIMITS.maxTimeoutMs
  ) {
    return validationError("timeoutMs");
  }
  if (instruction.subject === "target") {
    return isGuideWaitEvent(instruction.event)
      ? checkTarget(ports, instruction.target)
      : validationError("event");
  }
  if (instruction.subject === "route") {
    return checkRoute(ports, instruction.route);
  }
  return checkPredicate(ports, instruction.predicate);
}

function checkInstruction(
  ports: GuideRuntimePorts,
  instruction: GuideInstruction,
): GuideRuntimeError | null {
  switch (instruction.kind) {
    case "say":
    case "success":
      return checkMessage(instruction.message);
    case "focus":
    case "hint":
    case "annotate":
      return (
        checkMessage(instruction.message) ??
        checkSide(instruction.side) ??
        checkTarget(ports, instruction.target)
      );
    case "scroll":
      return checkTarget(ports, instruction.target);
    case "navigate":
      return checkRoute(ports, instruction.route);
    case "wait":
      return checkWait(ports, instruction);
    default:
      return null;
  }
}

/**
 * Every budget and every vocabulary membership, re-checked here against the
 * live registries. The parser checked the same things, and that is precisely
 * why this exists: a runtime that trusted the parser is one refactor away from
 * executing an 800-step trajectory against targets nobody registered.
 *
 * The source-text budgets (`maxProgramBytes`, `maxLines`) are deliberately not
 * re-checked — an AST has no source text, and the parser owns that boundary.
 */
function checkProgram(
  ports: GuideRuntimePorts,
  program: GuideProgram,
): GuideRuntimeError | null {
  if (program.version !== GUIDE_LANG_VERSION) return validationError("version");
  if (!isGuideGoalId(program.goal)) return validationError("goal");
  if (program.instructions.length > GUIDE_LIMITS.maxInstructions) {
    return validationError("maxInstructions");
  }
  const last = program.instructions.length - 1;
  for (let index = 0; index <= last; index += 1) {
    const instruction = program.instructions[index];
    if (instruction === undefined) return validationError("instructions");
    if (index !== last && isTerminalInstruction(instruction)) {
      return validationError("terminal");
    }
    const error = checkInstruction(ports, instruction);
    if (error !== null) return error;
  }
  return null;
}

function waitSubjectId(instruction: WaitInstruction): string {
  if (instruction.subject === "target") return instruction.target;
  if (instruction.subject === "route") return instruction.route;
  return instruction.predicate;
}

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
  ): void {
    publish({
      status,
      goal: run.goal,
      index: run.index,
      total: run.total,
      runId: run.id,
      message: run.message,
      error,
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

  function ensureMounted(run: ActiveRun, target: GuideTargetId): boolean {
    if (ports.targets.isMounted(target)) return true;
    // A guide pointing at nothing is worse than an honest error: the support
    // layer can replan from TARGET_NOT_MOUNTED, a person cannot follow a
    // highlight that is not on screen.
    failRun(run, { code: "TARGET_NOT_MOUNTED", detail: target });
    return false;
  }

  function point(instruction: PointingInstruction): Promise<void> {
    const request: GuideFocusRequest = {
      target: instruction.target,
      message: instruction.message,
      side: instruction.side,
    };
    if (instruction.kind === "focus") return ports.renderer.focus(request);
    if (instruction.kind === "hint") return ports.renderer.hint(request);
    return ports.renderer.annotate(request);
  }

  function observeSubject(
    instruction: WaitInstruction,
    signal: AbortSignal,
  ): Promise<void> {
    if (instruction.subject === "target") {
      return ports.targets.observe(
        instruction.target,
        instruction.event,
        signal,
      );
    }
    if (instruction.subject === "route") {
      return ports.routes.observe(instruction.route, signal);
    }
    return ports.state.observe(
      instruction.predicate,
      instruction.expected,
      signal,
    );
  }

  async function race(
    run: ActiveRun,
    instruction: WaitInstruction,
  ): Promise<WaitResolution> {
    const runSignal = run.controller.signal;
    if (runSignal.aborted) return "aborted";
    const observation = new AbortController();
    const deadline = new AbortController();
    const cascade = (): void => {
      observation.abort();
      deadline.abort();
    };
    runSignal.addEventListener("abort", cascade, { once: true });
    try {
      return await Promise.race([
        observeSubject(instruction, observation.signal).then(
          () => "observed" as const,
          () => "aborted" as const,
        ),
        ports.clock
          .after(instruction.timeoutMs, deadline.signal)
          .then(() => "timeout" as const),
      ]);
    } finally {
      // Whichever side lost still holds a listener inside its port; aborting
      // both is what makes a settled wait leave nothing behind.
      observation.abort();
      deadline.abort();
      runSignal.removeEventListener("abort", cascade);
    }
  }

  async function execute(run: ActiveRun, program: GuideProgram): Promise<void> {
    try {
      const invalid = checkProgram(ports, program);
      if (invalid !== null) {
        failRun(run, invalid);
        return;
      }
      let note: string = GUIDE_RUNTIME_NOTES.exhausted;
      for (let index = 0; index < program.instructions.length; index += 1) {
        const instruction = program.instructions[index];
        if (instruction === undefined || !isLive(run)) return;
        run.index = index;
        if (instruction.kind === "say" || instruction.kind === "success") {
          run.message = instruction.message;
        }
        publishRun(
          run,
          instruction.kind === "wait" ? "waiting" : "running",
          null,
        );
        note = GUIDE_RUNTIME_NOTES.exhausted;
        switch (instruction.kind) {
          case "say":
          case "success":
            break;
          case "focus":
          case "hint":
          case "annotate": {
            if (!ensureMounted(run, instruction.target)) return;
            await point(instruction);
            if (!isLive(run)) return;
            break;
          }
          case "scroll": {
            if (!ensureMounted(run, instruction.target)) return;
            const request: GuideScrollRequest = { target: instruction.target };
            await ports.renderer.scroll(request);
            if (!isLive(run)) return;
            break;
          }
          case "navigate":
            ports.routes.navigate(instruction.route);
            break;
          case "wait": {
            const resolution = await race(run, instruction);
            if (!isLive(run)) return;
            if (resolution === "timeout") {
              failRun(run, {
                code: "GUIDE_TIMEOUT",
                detail: waitSubjectId(instruction),
              });
              return;
            }
            if (resolution === "aborted") {
              // Cancellation settles the run itself, so reaching here means a
              // port rejected on its own: the subject can no longer be
              // observed, and the trajectory stops at that boundary.
              settleRun(run, {
                kind: "observed",
                goal: run.goal,
                route: ports.routes.current(),
                note: GUIDE_RUNTIME_NOTES.unobservable,
              });
              return;
            }
            note = GUIDE_RUNTIME_NOTES.waitSatisfied;
            break;
          }
          case "pause":
            publishRun(run, "paused", null);
            settleRun(run, { kind: "paused", goal: run.goal });
            return;
          case "end":
            ports.renderer.clear();
            publishRun(run, "done", null);
            settleRun(run, { kind: "completed", goal: run.goal });
            return;
        }
      }
      if (!isLive(run)) return;
      publishRun(run, "done", null);
      settleRun(run, {
        kind: "observed",
        goal: run.goal,
        route: ports.routes.current(),
        note,
      });
    } catch {
      // A port that throws is a defect on our side of the boundary, but the
      // caller is awaiting an outcome: settle rather than reject.
      failRun(run, validationError("runtime"));
    }
  }

  function start(program: GuideProgram): Promise<GuideOutcome> {
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
    };
    active = run;
    void execute(run, program).catch(() => {
      // `execute` is guarded end to end; this exists so that no defect can
      // surface as an unhandled rejection or as a promise that never settles.
      failRun(run, validationError("runtime"));
    });
    return outcome;
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
