/**
 * Tour mode: a person walking a tutorial at their own pace.
 *
 * `auto` mode is a trajectory — it runs to the next observation boundary and
 * every wait carries a deadline. A tutorial is the other thing: it holds on
 * each step until the person says Next, it moves on by itself when they do
 * the thing it points at, it never times out on somebody reading, and when a
 * control is not on screen it keeps the step as text instead of failing the
 * guide. Back and Replay exist because a person who missed a step should be
 * able to read it again.
 *
 * Nothing here is new authority. The directives are the same ten, the checks
 * are the same checks (`checkProgram` ran before this does), and Next is the
 * *person's* command arriving through `post`: the runtime still cannot click,
 * type or submit, and a command that arrives while no step is listening is
 * dropped rather than remembered, so a double press cannot skip a step the
 * person never read.
 */

import type {
  GuideProgram,
  GuideRouteId,
  WaitInstruction,
} from "@opensesame/guide-lang";

import { type GuideBeat, type GuidePlan, planGuideSteps } from "./plan.js";
import type {
  GuideOutcome,
  GuideRuntimeError,
  GuideRuntimePorts,
  GuideRuntimeStatus,
  GuideTourView,
} from "./ports.js";

export type TourCommand = "next" | "back" | "restart";

/** The slice of a run the tour loop reads and writes. */
export type TourRun = {
  readonly goal: GuideProgram["goal"];
  readonly controller: AbortController;
  /** Set only while a step is listening; `post` is a no-op otherwise. */
  wake: ((command: TourCommand) => void) | null;
};

export type TourHost = {
  readonly ports: GuideRuntimePorts;
  isLive(run: TourRun): boolean;
  publish(
    run: TourRun,
    status: GuideRuntimeStatus,
    tour: GuideTourView | null,
    index: number,
  ): void;
  settle(run: TourRun, outcome: GuideOutcome): void;
  fail(run: TourRun, error: GuideRuntimeError): void;
};

/** How long a step waits for its control to appear before it shows as text. */
export const TOUR_APPEAR_GRACE_MS = 2500;
/** How long a preamble wait is allowed to hold before the step is shown anyway. */
const PREAMBLE_PATIENCE_MS = 5000;

type Wake =
  | { readonly kind: "command"; readonly command: TourCommand }
  | { readonly kind: "aborted" };

type Raced =
  | Wake
  | { readonly kind: "observed" }
  | { readonly kind: "elapsed" };

/** Delivers a person's command to the step that is listening, if any. */
export function postTourCommand(run: TourRun, command: TourCommand): void {
  run.wake?.(command);
}

type Listener = { readonly promise: Promise<Wake>; readonly stop: () => void };

function listen(run: TourRun): Listener {
  let release: (wake: Wake) => void = () => {};
  const promise = new Promise<Wake>((resolve) => {
    release = resolve;
  });
  const onAbort = (): void => release({ kind: "aborted" });
  const own = (command: TourCommand): void => {
    release({ kind: "command", command });
  };
  run.wake = own;
  if (run.controller.signal.aborted) onAbort();
  else run.controller.signal.addEventListener("abort", onAbort, { once: true });
  return {
    promise,
    stop: () => {
      if (run.wake === own) run.wake = null;
      run.controller.signal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Races a wait against the person and, optionally, a patience deadline. The
 * losing sides are aborted, so nothing keeps listening after a step moves on.
 */
async function raceWith(
  host: TourHost,
  run: TourRun,
  observe: ((signal: AbortSignal) => Promise<void>) | null,
  patienceMs: number | null,
): Promise<Raced> {
  const listener = listen(run);
  const side = new AbortController();
  const sides: Promise<Raced>[] = [listener.promise];
  if (observe !== null) {
    sides.push(
      observe(side.signal).then(
        () => ({ kind: "observed" }) as const,
        () => ({ kind: "aborted" }) as const,
      ),
    );
  }
  if (patienceMs !== null) {
    sides.push(
      host.ports.clock
        .after(patienceMs, side.signal)
        .then(() => ({ kind: "elapsed" }) as const),
    );
  }
  try {
    return await Promise.race(sides);
  } finally {
    side.abort();
    listener.stop();
  }
}

function viewOf(
  plan: GuidePlan,
  beat: GuideBeat,
  degraded: boolean,
  satisfied = false,
) {
  const view: GuideTourView = {
    step: Math.min(beat.ordinal + 1, plan.stepCount),
    count: plan.stepCount,
    kind: beat.kind,
    message: beat.message,
    target: beat.target,
    side: beat.side,
    action: beat.until !== null && !satisfied,
    degraded,
    canBack: beat.ordinal > 0,
  };
  return view;
}

/** Settles when the program's own wait would settle; rejects on abort. */
function observeWait(
  ports: GuideRuntimePorts,
  wait: WaitInstruction,
  signal: AbortSignal,
): Promise<void> {
  if (wait.subject === "target") {
    return ports.targets.observe(wait.target, wait.event, signal);
  }
  if (wait.subject === "route") return ports.routes.observe(wait.route, signal);
  return ports.state.observe(wait.predicate, wait.expected, signal);
}

/**
 * Whether the wait is already true. A step that points at something the
 * person is already standing on must not skip itself — it holds for Next like
 * any other, and only a wait that is still to happen is theirs to satisfy.
 * An activation is an edge, so it is never already true.
 */
function alreadyHolds(
  ports: GuideRuntimePorts,
  wait: WaitInstruction,
): boolean {
  if (wait.subject === "route") return ports.routes.current() === wait.route;
  if (wait.subject === "state") {
    return ports.state.read(wait.predicate) === wait.expected;
  }
  if (wait.event === "appear") return ports.targets.isMounted(wait.target);
  if (wait.event === "disappear") return !ports.targets.isMounted(wait.target);
  return false;
}

/** What a beat's entry decided: carry on to present it, or move the cursor. */
type Entry =
  | { readonly kind: "present"; readonly degraded: boolean }
  | { readonly kind: "move"; readonly command: TourCommand }
  | { readonly kind: "stop" };

type TourContext = {
  readonly host: TourHost;
  readonly run: TourRun;
  readonly program: GuideProgram;
  readonly plan: GuidePlan;
};

/**
 * What an interrupted wait means for the step being entered: the run ended,
 * Back or Replay leaves the step, and Next only stops the waiting — the step
 * is still shown. `null` is "carry on".
 */
function interruption(raced: Raced, live: boolean): Entry | null {
  if (!live || raced.kind === "aborted") return { kind: "stop" };
  if (raced.kind === "command" && raced.command !== "next") {
    return { kind: "move", command: raced.command };
  }
  return null;
}

/** The automatic part of a step: navigation, scrolling and the waits that make it ready. */
async function runPreamble(
  ctx: TourContext,
  beat: GuideBeat,
): Promise<Entry | null> {
  const { host, run, program } = ctx;
  const { ports } = host;
  // A synthetic close has no presenting instruction (`present` is -1): all of
  // its instructions are the preamble.
  const last = beat.present < 0 ? beat.end : beat.present;
  for (let index = beat.start; index < last; index += 1) {
    const instruction = program.instructions[index];
    if (instruction === undefined) continue;
    if (instruction.kind === "navigate") {
      ports.routes.navigate(instruction.route);
    } else if (instruction.kind === "scroll") {
      if (ports.targets.isMounted(instruction.target)) {
        await ports.renderer.scroll({ target: instruction.target });
      }
    } else if (instruction.kind === "wait") {
      const raced = await raceWith(
        host,
        run,
        (signal) => observeWait(ports, instruction, signal),
        Math.min(instruction.timeoutMs, PREAMBLE_PATIENCE_MS),
      );
      const stopped = interruption(raced, host.isLive(run));
      if (stopped !== null) return stopped;
    }
  }
  return null;
}

/** Back and Replay return to the screen a step expects, not wherever the person drifted. */
async function restoreRoute(
  ctx: TourContext,
  route: GuideRouteId | null,
): Promise<Entry | null> {
  const { host, run } = ctx;
  const { ports } = host;
  if (route === null || ports.routes.current() === route) return null;
  if (!ports.routes.isKnown(route)) return null;
  ports.routes.navigate(route);
  const raced = await raceWith(
    host,
    run,
    (signal) => ports.routes.observe(route, signal),
    PREAMBLE_PATIENCE_MS,
  );
  return interruption(raced, host.isLive(run));
}

/**
 * Gives a step's control a moment to appear, then lights it. A control that
 * never comes is not a failure: the step is shown as text.
 */
async function lightTarget(
  ctx: TourContext,
  beat: GuideBeat,
  target: NonNullable<GuideBeat["target"]>,
): Promise<Entry> {
  const { host, run } = ctx;
  const { ports } = host;
  let mounted = ports.targets.isMounted(target);
  if (!mounted) {
    const raced = await raceWith(
      host,
      run,
      (signal) => ports.targets.observe(target, "appear", signal),
      TOUR_APPEAR_GRACE_MS,
    );
    const interrupted = interruption(raced, host.isLive(run));
    if (interrupted !== null) return interrupted;
    // Next only stops the waiting: the step is still shown, as text when the
    // control never mounted.
    mounted = ports.targets.isMounted(target);
  }
  if (!mounted) return { kind: "present", degraded: true };

  await ports.renderer.scroll({ target });
  if (!host.isLive(run)) return { kind: "stop" };
  if (beat.pointer !== null && beat.message !== null) {
    const request = { target, message: beat.message, side: beat.side };
    if (beat.pointer === "focus") await ports.renderer.focus(request);
    else if (beat.pointer === "hint") await ports.renderer.hint(request);
    else await ports.renderer.annotate(request);
  }
  return host.isLive(run)
    ? { kind: "present", degraded: false }
    : { kind: "stop" };
}

async function enter(
  ctx: TourContext,
  beat: GuideBeat,
  arrived: "forward" | "back",
): Promise<Entry> {
  const { host, run, plan } = ctx;
  host.ports.renderer.clear();
  host.publish(run, "running", viewOf(plan, beat, false), beat.start);

  const prepared = await runPreamble(ctx, beat);
  if (prepared !== null) return prepared;
  if (arrived === "back") {
    const restored = await restoreRoute(ctx, beat.route);
    if (restored !== null) return restored;
  }
  return beat.target === null
    ? { kind: "present", degraded: false }
    : lightTarget(ctx, beat, beat.target);
}

/** Holds a presented step until the person moves it, or does what it waits for. */
async function holdBeat(
  ctx: TourContext,
  beat: GuideBeat,
  degraded: boolean,
): Promise<Raced> {
  const { host, run, plan } = ctx;
  const { ports } = host;
  const until = beat.until;
  const holds = until !== null && alreadyHolds(ports, until);
  host.publish(
    run,
    "waiting",
    viewOf(plan, beat, degraded, holds),
    beat.present < 0 ? beat.start : beat.present,
  );
  return raceWith(
    host,
    run,
    until !== null && !holds && !degraded
      ? (signal) => observeWait(ports, until, signal)
      : null,
    null,
  );
}

function nextCursor(cursor: number, command: TourCommand): number {
  if (command === "restart") return 0;
  return command === "back" ? Math.max(0, cursor - 1) : cursor + 1;
}

export async function runTour(
  host: TourHost,
  run: TourRun,
  program: GuideProgram,
): Promise<void> {
  const ctx: TourContext = {
    host,
    run,
    program,
    plan: planGuideSteps(program),
  };
  let cursor = 0;
  let arrived: "forward" | "back" = "forward";

  while (host.isLive(run)) {
    const beat = ctx.plan.beats[cursor];
    if (beat === undefined) return;
    const entry = await enter(ctx, beat, arrived);
    if (!host.isLive(run) || entry.kind === "stop") return;
    let command: TourCommand = "next";
    if (entry.kind === "move") {
      command = entry.command;
    } else {
      const raced = await holdBeat(ctx, beat, entry.degraded);
      if (!host.isLive(run) || raced.kind === "aborted") return;
      if (raced.kind === "command") command = raced.command;
      if (
        raced.kind === "command" &&
        command === "next" &&
        beat.kind === "close"
      ) {
        host.ports.renderer.clear();
        host.publish(run, "done", null, beat.start);
        host.settle(run, { kind: "completed", goal: run.goal });
        return;
      }
      // Anything else that ends the hold — a command, or the person doing
      // what the step waits for — is a move; doing it is a Next.
    }
    cursor = nextCursor(cursor, command);
    arrived = command === "next" ? "forward" : "back";
  }
}
