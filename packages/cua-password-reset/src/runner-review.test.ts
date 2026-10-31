import { describe, expect, it, vi } from "vitest";
import { DurableJournal, MemoryCheckpointJournal } from "./journal.js";
import { DurableResetRunner } from "./runner.js";
import { grants, run } from "./test-support.js";
import type { ResetEffects, ResetRun } from "./types.js";

function effects(overrides: Partial<ResetEffects> = {}): ResetEffects {
  return {
    execute: vi.fn<ResetEffects["execute"]>(async (step) => ({
      stepId: step.id,
      outcome: "completed",
    })),
    backupCandidate: vi.fn(async () => undefined),
    verifyCandidate: vi.fn(async () => "verified" as const),
    promoteCandidate: vi.fn(async () => undefined),
    compensate: vi.fn(async () => "compensated" as const),
    ...overrides,
  };
}

function runner(
  journal: DurableJournal,
  effects: ResetEffects,
): DurableResetRunner {
  return new DurableResetRunner(
    journal,
    effects,
    grants(),
    () => new Date("2026-10-27T00:00:01.000Z"),
  );
}

async function started(
  journal: DurableJournal,
  current: ResetRun,
): Promise<void> {
  await journal.append(current.id, { type: "run.started", run: current });
}

describe("runner review regressions", () => {
  it("treats a verify-login exception as indeterminate, never failed before submit", async () => {
    const journal = new DurableJournal(new MemoryCheckpointJournal());
    const current = run();
    current.recipe.steps = current.recipe.steps.slice(-2);
    const fx = effects({
      execute: vi.fn<ResetEffects["execute"]>(async (step) => {
        if (step.primitive === "verify-login") throw new Error("verify lost");
        return { stepId: step.id, outcome: "completed" };
      }),
    });
    const result = await runner(journal, fx).start(current);
    expect(result.status).toBe("reconciliation_required");
    expect(fx.promoteCandidate).not.toHaveBeenCalled();
    expect(await journal.events(current.id)).toContainEqual(
      expect.objectContaining({
        type: "step.outcome",
        operation: "verify-login",
        outcome: "submit_indeterminate",
      }),
    );
  });

  it("retries unknown and throwing reconciliation, then keeps the definitive verdict", async () => {
    const journal = new DurableJournal(new MemoryCheckpointJournal());
    const current = run();
    await started(journal, current);
    const verifyCandidate = vi
      .fn<ResetEffects["verifyCandidate"]>()
      .mockResolvedValueOnce("unknown")
      .mockRejectedValueOnce(new Error("verification unavailable"))
      .mockResolvedValue("verified");
    const fx = effects({ verifyCandidate });
    const owner = runner(journal, fx);
    expect((await owner.reconcile(current)).status).toBe(
      "reconciliation_required",
    );
    expect((await owner.reconcile(current)).status).toBe(
      "reconciliation_required",
    );
    expect((await owner.reconcile(current)).status).toBe("succeeded");
    expect((await owner.reconcile(current)).status).toBe("succeeded");
    expect(verifyCandidate).toHaveBeenCalledTimes(3);
    expect(verifyCandidate.mock.calls.map((call) => call[1].attempt)).toEqual([
      1, 2, 3,
    ]);
    expect(fx.promoteCandidate).toHaveBeenCalledTimes(1);
  });

  it("does not repeat a definitive failed verification", async () => {
    const journal = new DurableJournal(new MemoryCheckpointJournal());
    const current = run();
    await started(journal, current);
    const fx = effects({
      verifyCandidate: vi.fn(async () => "not_active" as const),
    });
    const owner = runner(journal, fx);
    expect((await owner.reconcile(current)).status).toBe("failed");
    expect((await owner.reconcile(current)).status).toBe("failed");
    expect(fx.verifyCandidate).toHaveBeenCalledTimes(1);
    expect(fx.compensate).toHaveBeenCalledTimes(1);
  });

  it("holds one run-level lease across intent, effect and outcome", async () => {
    const store = new MemoryCheckpointJournal();
    const firstJournal = new DurableJournal(store);
    const secondJournal = new DurableJournal(store);
    const current = run();
    await started(firstJournal, current);
    let releaseFirst = () => {};
    const firstEffect = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let active = 0;
    let maximumActive = 0;
    let first = true;
    const execute = vi.fn<ResetEffects["execute"]>(async (step) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (first) {
        first = false;
        await firstEffect;
      }
      active -= 1;
      return { stepId: step.id, outcome: "completed" };
    });
    const firstCaller = runner(firstJournal, effects({ execute })).resume(
      current,
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const secondCaller = runner(secondJournal, effects({ execute })).resume(
      current,
    );
    await Promise.resolve();
    expect(active).toBe(1);
    releaseFirst();
    const results = await Promise.all([firstCaller, secondCaller]);
    expect(results.map((result) => result.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(maximumActive).toBe(1);
    expect(execute).toHaveBeenCalledTimes(current.recipe.steps.length);
  });

  it("does not promote an approved recipe without current-run verification", async () => {
    const journal = new DurableJournal(new MemoryCheckpointJournal());
    const current = run();
    current.recipe.steps = [
      { id: "open", primitive: "navigate", path: "/login" },
    ];
    const fx = effects();
    const result = await runner(journal, fx).start(current);
    expect(result.status).toBe("reconciliation_required");
    expect(fx.promoteCandidate).not.toHaveBeenCalled();
    expect(
      (await journal.events(current.id)).some(
        (event) => event.type === "candidate.promoted",
      ),
    ).toBe(false);
  });
});
