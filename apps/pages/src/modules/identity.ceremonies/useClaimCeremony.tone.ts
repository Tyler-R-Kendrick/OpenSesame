import {
  CLAIM_WORDS,
  type ClaimStep,
} from "@opensesame/app-core/lib/claims/ceremony.js";

export type ClaimTone = "err" | "warn";

/** A wait for a session is not a failure; everything else with words is. */
export function toneOf(step: ClaimStep): ClaimTone | null {
  if (!step.message) return null;
  const { phase } = step;
  const waiting =
    phase.kind === "paused" &&
    phase.reason === "identity" &&
    step.message !== CLAIM_WORDS.guestFailed;
  return waiting ? "warn" : "err";
}
