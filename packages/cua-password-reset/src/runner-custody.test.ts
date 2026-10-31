import { describe, expect, it, vi } from "vitest";
import { fixedGrants } from "./grants.js";
import { DurableJournal, MemoryCheckpointJournal } from "./journal.js";
import { DurableResetRunner } from "./runner.js";
import { grant, grants, run } from "./test-support.js";
import type { ResetEffects } from "./types.js";

function effects(): ResetEffects {
  return {
    execute: vi.fn<ResetEffects["execute"]>(async (step) => ({
      stepId: step.id,
      outcome: "completed",
    })),
    backupCandidate: vi.fn(async () => undefined),
    verifyCandidate: vi.fn<ResetEffects["verifyCandidate"]>(
      async () => "verified",
    ),
    promoteCandidate: vi.fn(async () => undefined),
    compensate: vi.fn<ResetEffects["compensate"]>(async () => "compensated"),
  };
}

describe("runner candidate custody ordering", () => {
  it("durably backs up the method before password-fill intent", async () => {
    const store = new MemoryCheckpointJournal();
    const journal = new DurableJournal(store);
    const current = run();
    current.recipe.steps = [
      {
        id: "password",
        primitive: "fill-field",
        ref: "e3",
        purpose: "new-password",
      },
      { id: "submit", primitive: "submit", ref: "e4" },
      { id: "verify", primitive: "verify-login" },
    ];
    const fx = effects();
    await new DurableResetRunner(
      journal,
      fx,
      grants(),
      () => new Date("2026-10-27T00:00:01.000Z"),
    ).start(current);
    const types = (await journal.events(current.id)).map((event) =>
      event.type === "step.intent"
        ? `${event.type}:${event.stepId}`
        : event.type,
    );
    expect(types.indexOf("candidate.backed_up")).toBeLessThan(
      types.indexOf("step.intent:password"),
    );
  });

  it("refuses backup and generation when password production is not granted", async () => {
    const current = run();
    current.recipe.steps = [
      {
        id: "password",
        primitive: "fill-field",
        ref: "e3",
        purpose: "new-password",
      },
      { id: "submit", primitive: "submit", ref: "e4" },
    ];
    const provider = fixedGrants({
      "password_reset.browser.drive": grant(),
    });
    const fx = effects();
    await expect(
      new DurableResetRunner(
        new DurableJournal(new MemoryCheckpointJournal()),
        fx,
        provider,
        () => new Date("2026-10-27T00:00:01.000Z"),
      ).start(current),
    ).rejects.toThrow("separately approved");
    expect(fx.backupCandidate).not.toHaveBeenCalled();
    expect(fx.execute).not.toHaveBeenCalled();
  });
});
