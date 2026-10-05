/**
 * What a matched duress code does beyond its presentation.
 *
 * One seam, run from `continueAfterDuressMatch`, in two phases: `on_match`
 * before the presentation is shown (and before a locked one is refused), and
 * `after_session` once a decoy session exists. A runner never throws out of
 * here: the code has already been typed under duress, and an unlock that
 * visibly fails differently from an ordinary one is the tell the modes exist
 * to avoid. A runner that cannot finish leaves its own record of that.
 */

import { FREEZE_RUNNER } from "./freeze.js";
import type { DuressPlan } from "./mode.js";

export type EffectPhase = "on_match" | "after_session";

/** What the unlock path hands a runner; a runner narrows what it needs. */
export type EffectHost = Readonly<{ store: object }>;

export type EffectRunner = Readonly<{
  phase: EffectPhase;
  run: (body: unknown, host: EffectHost) => Promise<void>;
}>;

/**
 * A runner per effect name, added with its mode. An effect with no runner here
 * is a no-op, so a plan sealed by a newer build is never half-run by an older.
 */
const RUNNERS: ReadonlyMap<string, EffectRunner> = new Map<
  string,
  EffectRunner
>([["freeze", FREEZE_RUNNER]]);

/** Whether unlock can run `effect`: a mode may only seal one that it can. */
export function hasEffectRunner(effect: string): boolean {
  return RUNNERS.has(effect);
}

/** The runner over a given set of runners; the shipped one is bound below. */
export function effectRunnerFor(runners: ReadonlyMap<string, EffectRunner>) {
  return async (
    plan: DuressPlan | null,
    phase: EffectPhase,
    host: EffectHost,
  ): Promise<void> => {
    if (!plan) return;
    const runner = runners.get(plan.effect);
    if (!runner || runner.phase !== phase) return;
    try {
      await runner.run(plan.body, host);
    } catch {
      // See the header: nothing may surface here.
    }
  };
}

export const runDuressEffects = effectRunnerFor(RUNNERS);
