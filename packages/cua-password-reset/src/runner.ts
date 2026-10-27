import {
  type ResetGrantProvider,
  actionForPrimitive,
  assertResetGrant,
} from "./grants.js";
import type { DurableJournal, StepIntent } from "./journal.js";
import { recipeMatches } from "./recipe.js";
import type {
  RecipeStep,
  ResetAction,
  ResetEffects,
  ResetRun,
  StepOutcome,
  StepReceipt,
} from "./types.js";

export class DurableResetRunner {
  constructor(
    private readonly journal: DurableJournal,
    private readonly effects: ResetEffects,
    private readonly grants: ResetGrantProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(run: ResetRun): Promise<ResetRun> {
    return this.journal.exclusive(run.id, () => this.startLocked(run));
  }

  private async startLocked(run: ResetRun): Promise<ResetRun> {
    if ((await this.journal.events(run.id)).length > 0)
      throw new Error("A reset run id already has a journal");
    if (run.status !== "running" || run.cursor !== 0)
      throw new Error("A new reset run starts running at step zero");
    if (
      run.recipe.review !== "approved" ||
      !recipeMatches(run.recipe, run.origin)
    )
      throw new Error(
        "A reset requires an approved recipe for its exact origin",
      );
    this.authorize(
      run,
      actionForPrimitive(run.recipe.steps[0]?.primitive ?? "navigate"),
    );
    await this.journal.append(run.id, { type: "run.started", run });
    return this.drive(run, false);
  }

  async resume(run: ResetRun | string): Promise<ResetRun> {
    return this.journal.exclusive(runId(run), () => this.resumeLocked(run));
  }

  private async resumeLocked(run: ResetRun | string): Promise<ResetRun> {
    const restored = await this.restore(run);
    if (restored.status !== "running") return restored;
    return this.drive(restored, false);
  }

  async resumeAfterHuman(run: ResetRun | string): Promise<ResetRun> {
    return this.journal.exclusive(runId(run), () =>
      this.resumeAfterHumanLocked(run),
    );
  }

  private async resumeAfterHumanLocked(
    run: ResetRun | string,
  ): Promise<ResetRun> {
    const restored = await this.restore(run);
    if (restored.status !== "awaiting_human")
      throw new Error("The run is not waiting for a person");
    this.authorize(restored, "password_reset.human.takeover");
    return this.drive(await this.mark(restored, "running"), true);
  }

  private async drive(
    initial: ResetRun,
    allowManual: boolean,
  ): Promise<ResetRun> {
    let run = initial;
    const unfinished = await this.journal.unfinished(run.id);
    if (unfinished) {
      if (unfinished.replay === "reconcile")
        return this.mark(run, "reconciliation_required");
      if (unfinished.replay === "manual" && !allowManual)
        return this.mark(
          run,
          unfinished.replay === "manual" && isChallenge(unfinished.input)
            ? "awaiting_human"
            : "reconciliation_required",
        );
      run = await this.executeIntent(run, unfinished);
      if (run.status !== "running") return run;
    }

    while (run.cursor < run.recipe.steps.length) {
      const step = run.recipe.steps[run.cursor];
      if (!step) break;
      this.authorize(run, actionForPrimitive(step.primitive));
      if (step.primitive === "submit" || isPasswordFill(step))
        await this.ensureBackup(run);
      const id = effectId(run, `${step.id}:${step.primitive}`);
      const intent: StepIntent = {
        type: "step.intent",
        stepId: step.id,
        operation: step.primitive,
        effectId: id,
        attempt: await this.nextAttempt(run.id, id),
        replay: replayFor(step),
        input: step,
      };
      await this.journal.append(run.id, intent);
      run = await this.executeIntent(run, intent);
      if (run.status !== "running") return run;
    }
    return this.promote(run);
  }

  private async executeIntent(
    run: ResetRun,
    intent: StepIntent,
  ): Promise<ResetRun> {
    this.authorize(run, actionForPrimitive(intent.operation));
    let receipt: StepReceipt;
    try {
      receipt = await this.effects.execute(intent.input, run, {
        effectId: intent.effectId,
        attempt: intent.attempt,
      });
      if (receipt.stepId !== intent.stepId)
        throw new Error("Effect answered for another step");
    } catch {
      receipt = {
        stepId: intent.stepId,
        outcome:
          intent.operation === "submit" || intent.operation === "verify-login"
            ? "submit_indeterminate"
            : "failed_before_submit",
      };
    }
    await this.journal.append(run.id, {
      type: "step.outcome",
      stepId: intent.stepId,
      operation: intent.operation,
      effectId: intent.effectId,
      attempt: intent.attempt,
      outcome: receipt.outcome,
    });
    return this.applyOutcome(run, receipt.outcome);
  }

  private async applyOutcome(
    run: ResetRun,
    outcome: StepOutcome,
  ): Promise<ResetRun> {
    if (outcome === "waiting") return this.mark(run, "awaiting_human");
    if (outcome === "reconcile" || outcome === "submit_indeterminate")
      return this.mark(run, "reconciliation_required");
    if (outcome === "failed_before_submit") return this.mark(run, "failed");
    return {
      ...run,
      cursor: run.cursor + 1,
      updatedAt: this.now().toISOString(),
    };
  }

  async reconcile(run: ResetRun | string): Promise<ResetRun> {
    return this.journal.exclusive(runId(run), () => this.reconcileLocked(run));
  }

  private async reconcileLocked(run: ResetRun | string): Promise<ResetRun> {
    const restored = await this.restore(run);
    this.authorize(restored, "password_reset.run.reconcile");
    const id = effectId(restored, "reconciliation");
    const events = await this.journal.events(restored.id);
    let verdict:
      | Awaited<ReturnType<ResetEffects["verifyCandidate"]>>
      | undefined = events.flatMap((event) =>
      event.type === "reconciliation.outcome" &&
      event.effectId === id &&
      event.verdict !== "unknown"
        ? [event.verdict]
        : [],
    )[0];
    if (!verdict) {
      const attempt =
        events.filter(
          (event) =>
            event.type === "reconciliation.intent" && event.effectId === id,
        ).length + 1;
      const context = { effectId: id, attempt };
      await this.journal.append(restored.id, {
        type: "reconciliation.intent",
        ...context,
      });
      try {
        verdict = await this.effects.verifyCandidate(restored, context);
      } catch {
        verdict = "unknown";
      }
      await this.journal.append(restored.id, {
        type: "reconciliation.outcome",
        ...context,
        verdict,
      });
    }
    if (verdict === "verified") return this.promote(restored);
    if (verdict === "unknown")
      return this.mark(restored, "reconciliation_required");
    return this.compensateLocked(restored);
  }

  async compensate(run: ResetRun | string): Promise<ResetRun> {
    return this.journal.exclusive(runId(run), () => this.compensateLocked(run));
  }

  private async compensateLocked(run: ResetRun | string): Promise<ResetRun> {
    const restored = await this.restore(run);
    this.authorize(restored, "password_reset.run.compensate");
    const id = effectId(restored, "compensation");
    const events = await this.journal.events(restored.id);
    let result = events.flatMap((event) =>
      event.type === "compensation.outcome" && event.effectId === id
        ? [event.result]
        : [],
    )[0];
    if (!result) {
      const context = { effectId: id, attempt: 1 };
      await this.journal.append(restored.id, {
        type: "compensation.intent",
        ...context,
      });
      try {
        result = await this.effects.compensate(restored, context);
      } catch {
        result = "partial";
      }
      await this.journal.append(restored.id, {
        type: "compensation.outcome",
        ...context,
        result,
      });
    }
    return this.mark(
      restored,
      result === "compensated" ? "failed" : "compensation_required",
    );
  }

  private async ensureBackup(run: ResetRun): Promise<void> {
    const id = effectId(run, "candidate:backup");
    const events = await this.journal.events(run.id);
    if (
      events.some(
        (event) =>
          event.type === "candidate.backed_up" && event.effectId === id,
      )
    )
      return;
    this.authorize(run, "password_reset.password.produce");
    const context = { effectId: id, attempt: 1 };
    await this.journal.append(run.id, {
      type: "candidate.backup.intent",
      ...context,
    });
    await this.effects.backupCandidate(run, context);
    await this.journal.append(run.id, {
      type: "candidate.backed_up",
      ...context,
    });
  }

  private async promote(run: ResetRun): Promise<ResetRun> {
    if (run.status === "succeeded") return run;
    const id = effectId(run, "candidate:promotion");
    const events = await this.journal.events(run.id);
    const verifiedLogin = events.some(
      (event) =>
        event.type === "step.outcome" &&
        event.operation === "verify-login" &&
        event.outcome === "completed",
    );
    const independentlyReconciled = events.some(
      (event) =>
        event.type === "reconciliation.outcome" && event.verdict === "verified",
    );
    const verified =
      verifiedLogin ||
      (independentlyReconciled &&
        run.recipe.steps.some((step) => step.primitive === "verify-login"));
    if (!verified) return this.mark(run, "reconciliation_required");
    if (
      !events.some(
        (event) => event.type === "candidate.promoted" && event.effectId === id,
      )
    ) {
      await this.ensureBackup(run);
      this.authorize(run, "password_reset.item.use");
      const context = { effectId: id, attempt: 1 };
      await this.journal.append(run.id, {
        type: "candidate.promotion.intent",
        ...context,
      });
      await this.effects.promoteCandidate(run, context);
      await this.journal.append(run.id, {
        type: "candidate.promoted",
        ...context,
      });
    }
    return this.mark(run, "succeeded");
  }

  private async nextAttempt(runId: string, id: string): Promise<number> {
    return (
      (await this.journal.events(runId)).filter(
        (event) => event.type === "step.intent" && event.effectId === id,
      ).length + 1
    );
  }

  private async restore(run: ResetRun | string): Promise<ResetRun> {
    if (run instanceof Object) {
      const restored = await this.journal.restore(run.id);
      return { ...restored, grantIds: run.grantIds };
    }
    return this.journal.restore(run);
  }

  private authorize(run: ResetRun, action: ResetAction): void {
    assertResetGrant(this.grants.grant(action, run), run, action, this.now());
  }

  private async mark(
    run: ResetRun,
    status: ResetRun["status"],
  ): Promise<ResetRun> {
    if (run.status === status) return run;
    const at = this.now().toISOString();
    await this.journal.append(run.id, { type: "run.status", status, at });
    return { ...run, status, updatedAt: at };
  }
}

function effectId(run: ResetRun, operation: string): string {
  return `${run.id}:${operation}`;
}

function runId(run: ResetRun | string): string {
  return run instanceof Object ? run.id : run;
}

function isPasswordFill(step: RecipeStep): boolean {
  return step.primitive === "fill-field" && step.purpose === "new-password";
}

function isChallenge(step: RecipeStep): boolean {
  return [
    "await-human",
    "enter-email-code",
    "enter-TOTP",
    "passkey-prompt",
  ].includes(step.primitive);
}

function replayFor(step: RecipeStep): StepIntent["replay"] {
  if (
    step.primitive === "submit" ||
    step.primitive === "verify-login" ||
    step.primitive === "await-email-link" ||
    step.primitive === "click"
  )
    return "reconcile";
  if (step.primitive === "navigate" || step.primitive === "fill-field")
    return "idempotent";
  return "manual";
}
