/**
 * Narrow unlock / PRF adapters living in the TRIGGER tree (OWNERSHIP).
 * Callers wire these around unlock-methods / local-passkey-prf without
 * editing those hotspots from this swarm.
 */

import { TriggerAttemptPolicy } from "../trigger/attempt-policy.js";
import {
  type EnrollmentState,
  type SelectTriggerOptions,
  type TriggerMatch,
  selectTrigger,
} from "../trigger/enrollment.js";
import {
  type CeremonyBinding,
  assertCeremonyBinding,
  assertPrfPresent,
} from "./binding.js";
import {
  type PrfSignInGate,
  assertMayApplyLatePrfCallback,
  assertMayEnrollPrfSignInProtector,
  withPrfSignInGuard,
} from "./prf-guard.js";
import { CodeSubmissionBuffer } from "./submission.js";

export type UnlockCeremonyDeps = Readonly<{
  /** Optional inject for tests — default leaves caller's PRF fn untouched. */
  applySignInPrf?: (...args: never[]) => Promise<boolean>;
}>;

/**
 * Route a complete unlock code submission to at most one profile
 * before any forbidden key material is released to the caller.
 */
export type UnlockRouteInput = Readonly<{
  code: string;
  state: EnrollmentState;
  options?: SelectTriggerOptions;
  attempts?: TriggerAttemptPolicy;
}>;

export async function routeCompleteUnlockSubmission(
  input: UnlockRouteInput,
): Promise<TriggerMatch> {
  const attempts = input.attempts ?? new TriggerAttemptPolicy();
  const gate = attempts.beginCompleteAttempt();
  if (!gate.allowed) return { status: "throttled" };

  const match = await selectTrigger(input.code, input.state, input.options);
  if (match.status === "none") {
    attempts.recordCompleteMiss();
  } else if (match.status === "matched") {
    attempts.recordCompleteHit();
  }
  return match;
}

export function createUnlockCodeSession() {
  return {
    buffer: new CodeSubmissionBuffer(),
    attempts: new TriggerAttemptPolicy(),
    async submit(
      state: EnrollmentState,
      options?: SelectTriggerOptions,
    ): Promise<TriggerMatch> {
      const code = this.buffer.submitComplete();
      if (!code) return { status: "none" };
      return routeCompleteUnlockSubmission({
        code,
        state,
        options,
        attempts: this.attempts,
      } satisfies UnlockRouteInput);
    },
  };
}

/** Gate PRF sign-in protector enrollment (TRIGGER-D). */
export {
  assertMayEnrollPrfSignInProtector,
  assertMayApplyLatePrfCallback,
  withPrfSignInGuard,
  type PrfSignInGate,
};

/** Binding + missing PRF checks (TRIGGER-F). */
export { assertCeremonyBinding, assertPrfPresent, type CeremonyBinding };
