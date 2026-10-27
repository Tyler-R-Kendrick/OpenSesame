import type { JsonValue } from "@opensesame/os-domain";
import { z } from "zod";
import { restoreJournalRun } from "./journal-restore.js";
import {
  type CheckpointJournal,
  PRIMITIVES,
  RESET_ACTIONS,
  type ResetRun,
  recipeSchema,
  recipeStepSchema,
} from "./types.js";

const statusSchema = z.enum([
  "running",
  "awaiting_human",
  "reconciliation_required",
  "compensation_required",
  "succeeded",
  "failed",
]);
const runSchema: z.ZodType<ResetRun> = z
  .object({
    id: z.string().min(1).max(128),
    domain: z.string().min(1).max(253),
    origin: z.url(),
    itemId: z.string().min(1).max(128),
    transport: z.enum(["cdp", "extension", "proxy"]),
    grantIds: z.partialRecord(
      z.enum(RESET_ACTIONS),
      z.string().min(1).max(128),
    ),
    cursor: z.number().int().nonnegative(),
    status: statusSchema,
    recipe: recipeSchema,
    updatedAt: z.iso.datetime(),
  })
  .strict();
const effect = {
  effectId: z.string().min(1).max(256),
  attempt: z.number().int().positive(),
};
const stepIntent = z
  .object({
    type: z.literal("step.intent"),
    stepId: z.string(),
    operation: z.enum(PRIMITIVES),
    ...effect,
    replay: z.enum(["idempotent", "manual", "reconcile"]),
    input: recipeStepSchema,
  })
  .strict();
const stepOutcome = z
  .object({
    type: z.literal("step.outcome"),
    stepId: z.string(),
    operation: z.enum(PRIMITIVES),
    ...effect,
    outcome: z.enum([
      "completed",
      "waiting",
      "reconcile",
      "failed_before_submit",
      "submit_indeterminate",
    ]),
  })
  .strict();

export const journalEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run.started"), run: runSchema }).strict(),
  stepIntent,
  stepOutcome,
  z.object({ type: z.literal("candidate.backup.intent"), ...effect }).strict(),
  z.object({ type: z.literal("candidate.backed_up"), ...effect }).strict(),
  z
    .object({ type: z.literal("candidate.promotion.intent"), ...effect })
    .strict(),
  z.object({ type: z.literal("candidate.promoted"), ...effect }).strict(),
  z.object({ type: z.literal("reconciliation.intent"), ...effect }).strict(),
  z
    .object({
      type: z.literal("reconciliation.outcome"),
      ...effect,
      verdict: z.enum(["verified", "not_active", "unknown"]),
    })
    .strict(),
  z.object({ type: z.literal("compensation.intent"), ...effect }).strict(),
  z
    .object({
      type: z.literal("compensation.outcome"),
      ...effect,
      result: z.enum(["compensated", "unsupported", "partial"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("run.status"),
      status: statusSchema,
      at: z.iso.datetime(),
    })
    .strict(),
]);
export type JournalEvent = z.infer<typeof journalEventSchema>;
export type StepIntent = Extract<JournalEvent, { type: "step.intent" }>;
export type StepOutcomeEvent = Extract<JournalEvent, { type: "step.outcome" }>;

export class DurableJournal {
  constructor(private readonly store: CheckpointJournal) {}

  async events(runId: string): Promise<JournalEvent[]> {
    return (await this.store.load(runId)).map((event) =>
      journalEventSchema.parse(event),
    );
  }

  async append(runId: string, input: JournalEvent): Promise<void> {
    const event = journalEventSchema.parse(input);
    const events = await this.events(runId);
    const previous = events.find((candidate) =>
      sameEventIdentity(candidate, event),
    );
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(event))
        throw new Error(
          "A journal effect id was reused with different content",
        );
      return;
    }
    await this.store.append(runId, event);
  }

  async unfinished(runId: string): Promise<StepIntent | null> {
    const events = await this.events(runId);
    const outcomes = events.filter((event) => event.type === "step.outcome");
    const unfinished = events.filter(
      (event): event is StepIntent =>
        event.type === "step.intent" &&
        !outcomes.some(
          (outcome) =>
            outcome.effectId === event.effectId &&
            outcome.attempt === event.attempt,
        ),
    );
    if (unfinished.length > 1)
      throw new Error("Journal has multiple unfinished steps");
    return unfinished[0] ?? null;
  }

  async restore(runId: string): Promise<ResetRun> {
    return restoreJournalRun(await this.events(runId));
  }
}

function sameEventIdentity(left: JournalEvent, right: JournalEvent): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "run.started" || left.type === "run.status") return false;
  if (left.type === "step.intent" || left.type === "step.outcome")
    return (
      right.type === left.type &&
      left.effectId === right.effectId &&
      left.attempt === right.attempt
    );
  return (
    "effectId" in right &&
    left.effectId === right.effectId &&
    left.attempt === right.attempt
  );
}

export class MemoryCheckpointJournal implements CheckpointJournal {
  private readonly runs = new Map<string, JsonValue[]>();

  load(runId: string): Promise<readonly JsonValue[]> {
    return Promise.resolve(structuredClone(this.runs.get(runId) ?? []));
  }

  append(runId: string, event: JsonValue): Promise<void> {
    const events = this.runs.get(runId) ?? [];
    events.push(structuredClone(event));
    this.runs.set(runId, events);
    return Promise.resolve();
  }
}
