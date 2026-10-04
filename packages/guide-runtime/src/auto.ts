/**
 * Auto mode: a model's trajectory, run to its next observation boundary.
 *
 * Every wait carries a deadline, a control that is not on screen fails the
 * guide so the support layer can replan from `TARGET_NOT_MOUNTED`, and the
 * run settles on its own. Tour mode (`tour.ts`) is the person-paced twin.
 */

import type {
  AnnotateInstruction,
  FocusInstruction,
  GuideProgram,
  GuideTargetId,
  HintInstruction,
  ScrollInstruction,
  WaitInstruction,
} from "@opensesame/guide-lang";

import { GUIDE_RUNTIME_NOTES } from "./notes.js";
import type {
  GuideFocusRequest,
  GuideOutcome,
  GuideRuntimeError,
  GuideRuntimePorts,
  GuideRuntimeStatus,
  GuideScrollRequest,
} from "./ports.js";

type PointingInstruction =
  | AnnotateInstruction
  | FocusInstruction
  | HintInstruction;

type WaitResolution = "aborted" | "observed" | "timeout";

/** The slice of a run auto mode reads and writes. */
export type AutoRun = {
  readonly goal: GuideProgram["goal"];
  readonly controller: AbortController;
  index: number;
  message: string | null;
};

/** What auto mode needs of the runtime that owns the run. */
export type AutoOps<R extends AutoRun> = {
  readonly ports: GuideRuntimePorts;
  isLive(run: R): boolean;
  publishRun(
    run: R,
    status: GuideRuntimeStatus,
    error: GuideRuntimeError | null,
  ): void;
  failRun(run: R, error: GuideRuntimeError): void;
  settleRun(run: R, outcome: GuideOutcome): void;
};

function waitSubjectId(instruction: WaitInstruction): string {
  if (instruction.subject === "target") return instruction.target;
  if (instruction.subject === "route") return instruction.route;
  return instruction.predicate;
}

function point(
  ports: GuideRuntimePorts,
  instruction: PointingInstruction,
): Promise<void> {
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
  ports: GuideRuntimePorts,
  instruction: WaitInstruction,
  signal: AbortSignal,
): Promise<void> {
  if (instruction.subject === "target") {
    return ports.targets.observe(instruction.target, instruction.event, signal);
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
  ports: GuideRuntimePorts,
  run: AutoRun,
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
      observeSubject(ports, instruction, observation.signal).then(
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

/** Where a wait left the trajectory, or `null` to carry on. */
async function waitStep<R extends AutoRun>(
  ops: AutoOps<R>,
  run: R,
  instruction: WaitInstruction,
): Promise<boolean> {
  const { ports } = ops;
  const resolution = await race(ports, run, instruction);
  if (!ops.isLive(run)) return false;
  if (resolution === "timeout") {
    ops.failRun(run, {
      code: "GUIDE_TIMEOUT",
      detail: waitSubjectId(instruction),
    });
    return false;
  }
  if (resolution === "aborted") {
    // Cancellation settles the run itself, so reaching here means a port
    // rejected on its own: the subject can no longer be observed, and the
    // trajectory stops at that boundary.
    ops.settleRun(run, {
      kind: "observed",
      goal: run.goal,
      route: ports.routes.current(),
      note: GUIDE_RUNTIME_NOTES.unobservable,
    });
    return false;
  }
  return true;
}

function ensureMounted<R extends AutoRun>(
  ops: AutoOps<R>,
  run: R,
  target: GuideTargetId,
): boolean {
  if (ops.ports.targets.isMounted(target)) return true;
  // A guide pointing at nothing is worse than an honest error: the support
  // layer can replan from TARGET_NOT_MOUNTED, a person cannot follow a
  // highlight that is not on screen.
  ops.failRun(run, { code: "TARGET_NOT_MOUNTED", detail: target });
  return false;
}

/** What one instruction did to the trajectory. */
type Moved = "carry-on" | "satisfied" | "stop";

/** `focus`, `hint`, `annotate` and `scroll`: put something on the page. */
async function showStep<R extends AutoRun>(
  ops: AutoOps<R>,
  run: R,
  instruction: PointingInstruction | ScrollInstruction,
): Promise<Moved> {
  if (!ensureMounted(ops, run, instruction.target)) return "stop";
  if (instruction.kind === "scroll") {
    const request: GuideScrollRequest = { target: instruction.target };
    await ops.ports.renderer.scroll(request);
  } else {
    await point(ops.ports, instruction);
  }
  return ops.isLive(run) ? "carry-on" : "stop";
}

/** `pause` and `end`: the trajectory settles here. */
function endStep<R extends AutoRun>(
  ops: AutoOps<R>,
  run: R,
  kind: "pause" | "end",
): void {
  if (kind === "end") ops.ports.renderer.clear();
  ops.publishRun(run, kind === "end" ? "done" : "paused", null);
  ops.settleRun(
    run,
    kind === "end"
      ? { kind: "completed", goal: run.goal }
      : { kind: "paused", goal: run.goal },
  );
}

async function stepOnce<R extends AutoRun>(
  ops: AutoOps<R>,
  run: R,
  instruction: GuideProgram["instructions"][number],
): Promise<Moved> {
  switch (instruction.kind) {
    case "focus":
    case "hint":
    case "annotate":
    case "scroll":
      return showStep(ops, run, instruction);
    case "navigate":
      ops.ports.routes.navigate(instruction.route);
      return "carry-on";
    case "wait":
      return (await waitStep(ops, run, instruction)) ? "satisfied" : "stop";
    case "pause":
    case "end":
      endStep(ops, run, instruction.kind);
      return "stop";
    default:
      return "carry-on";
  }
}

export async function runAuto<R extends AutoRun>(
  ops: AutoOps<R>,
  run: R,
  program: GuideProgram,
): Promise<void> {
  let note: string = GUIDE_RUNTIME_NOTES.exhausted;
  for (let index = 0; index < program.instructions.length; index += 1) {
    const instruction = program.instructions[index];
    if (instruction === undefined || !ops.isLive(run)) return;
    run.index = index;
    if (instruction.kind === "say" || instruction.kind === "success") {
      run.message = instruction.message;
    }
    ops.publishRun(
      run,
      instruction.kind === "wait" ? "waiting" : "running",
      null,
    );
    const moved = await stepOnce(ops, run, instruction);
    if (moved === "stop") return;
    note =
      moved === "satisfied"
        ? GUIDE_RUNTIME_NOTES.waitSatisfied
        : GUIDE_RUNTIME_NOTES.exhausted;
  }
  if (!ops.isLive(run)) return;
  ops.publishRun(run, "done", null);
  ops.settleRun(run, {
    kind: "observed",
    goal: run.goal,
    route: ops.ports.routes.current(),
    note,
  });
}
