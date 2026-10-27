import { beforeEach, describe, expect, it, vi } from "vitest";
import { DurableJournal, MemoryCheckpointJournal } from "./journal.js";
import { DurableResetRunner } from "./runner.js";
import { grant, grants, run } from "./test-support.js";
import type { CheckpointJournal, ResetEffects, ResetRun } from "./types.js";

function effects(overrides: Partial<ResetEffects> = {}, completeAll = false) {
  return {
    execute: vi.fn<ResetEffects["execute"]>(async (step) => ({
      stepId: step.id,
      outcome:
        !completeAll && step.primitive === "await-email-link"
          ? "waiting"
          : "completed",
    })),
    backupCandidate: vi.fn(async () => undefined),
    verifyCandidate: vi.fn(async () => "verified" as const),
    promoteCandidate: vi.fn(async () => undefined),
    compensate: vi.fn(async () => "compensated" as const),
    ...overrides,
  } satisfies ResetEffects;
}

function stepAt(
  current: ResetRun,
  index: number,
): ResetRun["recipe"]["steps"][number] {
  const step = current.recipe.steps[index];
  if (!step) throw new Error(`Missing fixture step ${index}`);
  return step;
}

function runner(
  journal: DurableJournal,
  fx: ResetEffects,
  provider = grants(),
) {
  return new DurableResetRunner(
    journal,
    fx,
    provider,
    () => new Date("2026-10-27T00:00:01.000Z"),
  );
}

async function settle(
  journal: DurableJournal,
  fx: ResetEffects,
  runId: string,
) {
  let current = await journal.restore(runId);
  for (let count = 0; count < 20; count++) {
    if (["succeeded", "failed"].includes(current.status)) return current;
    if (current.status === "awaiting_human")
      current = await runner(journal, fx).resumeAfterHuman(current);
    else if (current.status === "reconciliation_required")
      current = await runner(journal, fx).reconcile(current);
    else if (current.status === "compensation_required")
      current = await runner(journal, fx).compensate(current);
    else current = await runner(journal, fx).resume(current);
  }
  throw new Error("Run did not settle");
}

class CrashJournal implements CheckpointJournal {
  constructor(
    private readonly inner: MemoryCheckpointJournal,
    private countdown: number,
  ) {}
  load(runId: string) {
    return this.inner.load(runId);
  }
  async append(runId: string, event: unknown) {
    await this.inner.append(runId, event);
    this.countdown--;
    if (this.countdown === 0) throw new Error("crash after journal append");
  }
}

describe("durable reset runner", () => {
  let store: MemoryCheckpointJournal;
  let journal: DurableJournal;
  beforeEach(() => {
    store = new MemoryCheckpointJournal();
    journal = new DurableJournal(store);
  });

  it("restores completed work and never trusts a caller cursor or status", async () => {
    const initial = run();
    const fx = effects({}, true);
    await runner(journal, fx).start(initial);
    const resumedFx = effects({}, true);
    const result = await runner(journal, resumedFx).resume({
      ...initial,
      cursor: 0,
      status: "running",
    });
    expect(result.status).toBe("succeeded");
    expect(result.cursor).toBe(initial.recipe.steps.length);
    expect(resumedFx.execute).not.toHaveBeenCalled();
    expect(fx.backupCandidate).toHaveBeenCalledTimes(1);
    expect(fx.promoteCandidate).toHaveBeenCalledTimes(1);
  });

  it("marks navigation and fills idempotent but page mutations reconciled", async () => {
    const initial = run();
    initial.recipe.steps = initial.recipe.steps.slice(0, 3);
    await runner(journal, effects({}, true)).start(initial);
    const intents = (await journal.events(initial.id)).filter(
      (event) => event.type === "step.intent",
    );
    expect(intents.map((event) => event.replay)).toEqual([
      "idempotent",
      "idempotent",
      "reconcile",
    ]);
  });

  it("retries only an idempotent interrupted step with the same effect id", async () => {
    const initial = run();
    const step = stepAt(initial, 0);
    await journal.append(initial.id, { type: "run.started", run: initial });
    await journal.append(initial.id, {
      type: "step.intent",
      stepId: step.id,
      operation: step.primitive,
      effectId: `${initial.id}:${step.id}:${step.primitive}`,
      attempt: 1,
      replay: "idempotent",
      input: step,
    });
    const fx = effects({}, true);
    await runner(journal, fx).resume(initial.id);
    expect(fx.execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "open" }),
      expect.anything(),
      { effectId: "run-1:open:navigate", attempt: 1 },
    );
  });

  it("reconciles an interrupted page mutation without replaying it", async () => {
    const initial = run();
    initial.recipe.steps = [{ id: "request", primitive: "click", ref: "e2" }];
    const step = stepAt(initial, 0);
    await journal.append(initial.id, { type: "run.started", run: initial });
    await journal.append(initial.id, {
      type: "step.intent",
      stepId: step.id,
      operation: step.primitive,
      effectId: `${initial.id}:${step.id}:${step.primitive}`,
      attempt: 1,
      replay: "manual",
      input: step,
    });
    const fx = effects({}, true);
    const parked = await runner(journal, fx).resume(initial.id);
    expect(parked.status).toBe("reconciliation_required");
    expect(fx.execute).not.toHaveBeenCalled();
    expect((await runner(journal, fx).reconcile(parked)).status).toBe(
      "succeeded",
    );
    expect(fx.execute).not.toHaveBeenCalled();
  });

  it("never blindly retries submit and promotes once after reconciliation", async () => {
    const initial = run();
    const step = stepAt(initial, 5);
    await journal.append(initial.id, { type: "run.started", run: initial });
    await journal.append(initial.id, {
      type: "candidate.backed_up",
      effectId: "run-1:candidate:backup",
      attempt: 1,
    });
    await journal.append(initial.id, {
      type: "step.intent",
      stepId: step.id,
      operation: step.primitive,
      effectId: `${initial.id}:${step.id}:${step.primitive}`,
      attempt: 1,
      replay: "reconcile",
      input: step,
    });
    const fx = effects({}, true);
    const resumed = await runner(journal, fx).resume(initial.id);
    expect(resumed.status).toBe("reconciliation_required");
    expect(fx.execute).not.toHaveBeenCalled();
    expect((await runner(journal, fx).reconcile(resumed)).status).toBe(
      "succeeded",
    );
    expect((await runner(journal, fx).reconcile(resumed)).status).toBe(
      "succeeded",
    );
    expect(fx.promoteCandidate).toHaveBeenCalledTimes(1);
    expect(fx.verifyCandidate).toHaveBeenCalledTimes(1);
  });

  it("makes compensation durable and idempotent, and retains an unknown outcome", async () => {
    const initial = run();
    await journal.append(initial.id, { type: "run.started", run: initial });
    const fx = effects({
      verifyCandidate: vi.fn(async () => "not_active" as const),
    });
    expect((await runner(journal, fx).reconcile(initial)).status).toBe(
      "failed",
    );
    expect((await runner(journal, fx).compensate(initial)).status).toBe(
      "failed",
    );
    expect(fx.compensate).toHaveBeenCalledTimes(1);
    const unknownFx = effects({
      verifyCandidate: vi.fn(async () => "unknown" as const),
    });
    const unknownJournal = new DurableJournal(new MemoryCheckpointJournal());
    await unknownJournal.append(initial.id, {
      type: "run.started",
      run: initial,
    });
    expect(
      (await runner(unknownJournal, unknownFx).reconcile(initial)).status,
    ).toBe("reconciliation_required");
    expect(unknownFx.compensate).not.toHaveBeenCalled();
  });

  it("repeats the waiting step after handback instead of skipping it", async () => {
    const initial = run();
    let mailAttempts = 0;
    const execute = vi.fn<ResetEffects["execute"]>(async (step) => ({
      stepId: step.id,
      outcome:
        step.primitive === "await-email-link" && ++mailAttempts === 1
          ? "waiting"
          : "completed",
    }));
    const fx = effects({ execute });
    const waiting = await runner(journal, fx).start(initial);
    expect(waiting.status).toBe("awaiting_human");
    expect(waiting.cursor).toBe(3);
    expect((await runner(journal, fx).resumeAfterHuman(waiting)).status).toBe(
      "succeeded",
    );
    expect(execute).toHaveBeenCalledTimes(initial.recipe.steps.length + 1);
    expect(execute.mock.calls[3]?.[0].primitive).toBe("await-email-link");
    expect(execute.mock.calls[4]?.[0].primitive).toBe("await-email-link");
  });

  it("records failure before submit separately from an indeterminate submit", async () => {
    const before = effects({
      execute: vi.fn<ResetEffects["execute"]>(async () => {
        throw new Error("driver lost");
      }),
    });
    const failed = await runner(journal, before).start(run());
    expect(failed.status).toBe("failed");
    expect(
      (await journal.events(run().id)).some(
        (event) =>
          event.type === "step.outcome" &&
          event.outcome === "failed_before_submit",
      ),
    ).toBe(true);

    const submitRun = run();
    submitRun.recipe.steps = [stepAt(submitRun, 5)];
    const after = effects({
      execute: vi.fn<ResetEffects["execute"]>(async () => {
        throw new Error("lost");
      }),
    });
    const submitJournal = new DurableJournal(new MemoryCheckpointJournal());
    const indeterminate = await runner(submitJournal, after).start(submitRun);
    expect(indeterminate.status).toBe("reconciliation_required");
    expect(
      (await submitJournal.events(submitRun.id)).some(
        (event) =>
          event.type === "step.outcome" &&
          event.outcome === "submit_indeterminate",
      ),
    ).toBe(true);
  });

  it("accepts duplicate identical outcomes and rejects a conflicting duplicate", async () => {
    const initial = run();
    const step = stepAt(initial, 0);
    const outcome = {
      type: "step.outcome" as const,
      stepId: step.id,
      operation: step.primitive,
      effectId: "run-1:open:navigate",
      attempt: 1,
      outcome: "completed" as const,
    };
    await journal.append(initial.id, outcome);
    await journal.append(initial.id, outcome);
    expect((await store.load(initial.id)).length).toBe(1);
    await expect(
      journal.append(initial.id, { ...outcome, outcome: "waiting" }),
    ).rejects.toThrow("different content");
  });

  it("checks the exact live grant before every effect", async () => {
    let browser = grant("password_reset.browser.drive");
    const provider = {
      grant: (
        action: Parameters<ReturnType<typeof grants>["grant"]>[0],
        current: ResetRun,
      ) =>
        action === "password_reset.browser.drive"
          ? browser
          : grants().grant(action, current),
    };
    const fx = effects(
      {
        execute: vi.fn<ResetEffects["execute"]>(async (step) => {
          if (step.id === "open")
            browser = {
              ...browser,
              revokedAt: new Date("2026-10-27T00:00:00.000Z"),
            };
          return { stepId: step.id, outcome: "completed" };
        }),
      },
      true,
    );
    await expect(runner(journal, fx, provider).start(run())).rejects.toThrow();
    expect(fx.execute).toHaveBeenCalledTimes(1);
  });

  it("resumes from every journal crash boundary without duplicate promotion", async () => {
    const cleanStore = new MemoryCheckpointJournal();
    await runner(new DurableJournal(cleanStore), effects({}, true)).start(
      run(),
    );
    const boundaries = (await cleanStore.load(run().id)).length;
    for (let boundary = 1; boundary <= boundaries; boundary++) {
      const crashedStore = new MemoryCheckpointJournal();
      const promotions = new Set<string>();
      const fx = effects(
        {
          promoteCandidate: vi.fn(async (_run, context) => {
            promotions.add(context.effectId);
          }),
        },
        true,
      );
      const crashing = new DurableJournal(
        new CrashJournal(crashedStore, boundary),
      );
      await expect(runner(crashing, fx).start(run())).rejects.toThrow("crash");
      const durable = new DurableJournal(crashedStore);
      const settled = await settle(durable, fx, run().id);
      expect(settled.status, `crash boundary ${boundary}/${boundaries}`).toBe(
        "succeeded",
      );
      expect(promotions.size, `crash boundary ${boundary}/${boundaries}`).toBe(
        1,
      );
    }
  });
});
