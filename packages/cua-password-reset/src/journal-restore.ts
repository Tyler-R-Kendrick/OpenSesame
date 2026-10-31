import type { JournalEvent } from "./journal.js";
import type { ResetRun } from "./types.js";

export function restoreJournalRun(events: readonly JournalEvent[]): ResetRun {
  const started = events.filter((event) => event.type === "run.started");
  if (started.length !== 1 || started[0]?.type !== "run.started")
    throw new Error("Reset run must have exactly one starting checkpoint");
  let run = started[0].run;
  assertRecipeMatches(run, events);
  run = restoreCursor(run, events);
  return restoreStatus(run, events);
}

function assertRecipeMatches(
  run: ResetRun,
  events: readonly JournalEvent[],
): void {
  for (const step of run.recipe.steps) {
    const mismatched = events.some(
      (event) =>
        event.type === "step.intent" &&
        event.stepId === step.id &&
        (event.operation !== step.primitive ||
          JSON.stringify(event.input) !== JSON.stringify(step)),
    );
    if (mismatched) throw new Error("Journal step does not match its recipe");
  }
}

function restoreCursor(
  run: ResetRun,
  events: readonly JournalEvent[],
): ResetRun {
  const completed = new Set(
    events.flatMap((event) =>
      event.type === "step.outcome" && event.outcome === "completed"
        ? [event.stepId]
        : [],
    ),
  );
  const cursor = run.recipe.steps.findIndex((step) => !completed.has(step.id));
  return {
    ...run,
    cursor: cursor < 0 ? run.recipe.steps.length : cursor,
  };
}

function restoreStatus(
  initial: ResetRun,
  events: readonly JournalEvent[],
): ResetRun {
  let run = initial;
  const lastStatus = events.reduce(
    (found, event, index) => (event.type === "run.status" ? index : found),
    -1,
  );
  const status = lastStatus < 0 ? undefined : events[lastStatus];
  if (status?.type === "run.status")
    run = { ...run, status: status.status, updatedAt: status.at };
  if (lastStatus === events.length - 1) return run;
  const latest = events.at(-1);
  if (latest?.type === "step.outcome" && latest.outcome !== "completed")
    run = { ...run, status: outcomeStatus(latest.outcome) };
  if (latest?.type === "candidate.promoted")
    run = { ...run, status: "succeeded" };
  return run;
}

function outcomeStatus(
  outcome: Extract<JournalEvent, { type: "step.outcome" }>["outcome"],
): ResetRun["status"] {
  if (outcome === "waiting") return "awaiting_human";
  if (outcome === "failed_before_submit") return "failed";
  return "reconciliation_required";
}
