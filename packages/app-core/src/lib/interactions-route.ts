/**
 * What the `/i/:ref` route shows for an arrival (ADR 0140 plan step 9), with
 * no React: which reference opens, which link ended before it began, and the
 * one tray notice an interaction's refusal is reported through. The words
 * are ceremony-kit's (`INTERACTION_WORDS`, `INTERACTION_ERROR_WORDS`,
 * `OUTCOME_TEXT`); a screen never writes its own.
 */

import {
  INTERACTION_ERROR_WORDS,
  INTERACTION_LABELS,
  INTERACTION_WORDS,
  type InteractionArrival,
  type InteractionPhase,
  type InteractionStep,
  OUTCOME_IS_REFUSAL,
  OUTCOME_TEXT,
  type Outcome,
  ceremonyRouterPath,
  matchCeremonyPath,
} from "@opensesame/ceremony-kit";
import { dismissNotice, setStatusNotice } from "./notices.js";

export { INTERACTION_LABELS, ceremonyRouterPath };
export type { InteractionPhase, InteractionStep, Outcome };

/** What the sign-in step says when the model said nothing more. */
export const INTERACTION_SIGN_IN = INTERACTION_ERROR_WORDS.approval_required;

/** The tray notice an interaction reports through, one at a time. */
export const INTERACTION_NOTICE = "identity.interaction";

export type InteractionEntry =
  | { kind: "ceremony"; ref: string }
  /** The link ended the question before anything was called. */
  | { kind: "ended"; outcome: Outcome; words: string };

/**
 * Where `pathname` starts, given what the address carried. A reference is
 * opened only when the route's own path names exactly it — a reference held
 * from an earlier address never answers for another path.
 */
export function interactionEntry(
  arrival: InteractionArrival,
  pathname: string,
): InteractionEntry {
  const at = matchCeremonyPath("interaction", pathname)?.ref;
  if (arrival.kind === "interaction" && arrival.ref === at) {
    return { kind: "ceremony", ref: arrival.ref };
  }
  if (arrival.kind === "refused") {
    return {
      kind: "ended",
      outcome: "refused",
      words: INTERACTION_WORDS.linkRefused,
    };
  }
  return {
    kind: "ended",
    outcome: "missing",
    words: INTERACTION_ERROR_WORDS.interaction_not_found,
  };
}

/** The sentence for an ending the person did not choose; `null` for theirs. */
const ENDED_WORDS: Readonly<Record<Outcome, string | null>> = {
  approved: null,
  denied: null,
  consumed: INTERACTION_ERROR_WORDS.interaction_consumed,
  expired: INTERACTION_ERROR_WORDS.interaction_expired,
  revoked: INTERACTION_ERROR_WORDS.interaction_revoked,
  missing: INTERACTION_ERROR_WORDS.interaction_not_found,
  refused: INTERACTION_WORDS.linkRefused,
};

/** How an ending reads on a mark: its word, its sentence, and its tone. */
export function outcomeMark(outcome: Outcome): {
  tone: "ok" | "err";
  label: string;
  words: string;
} {
  return {
    tone: OUTCOME_IS_REFUSAL[outcome] ? "err" : "ok",
    label: OUTCOME_TEXT[outcome],
    words: ENDED_WORDS[outcome] ?? OUTCOME_TEXT[outcome],
  };
}

/**
 * What a step says to the tray: its message, or the sentence for an ending
 * the person did not choose. An approval or a deny they pressed says nothing.
 */
export function interactionStepWords(step: InteractionStep): string | null {
  if (step.message) return step.message;
  return step.phase.kind === "done" ? ENDED_WORDS[step.phase.outcome] : null;
}

const TITLE = "Approval";

/** Say why an interaction stopped, in the tray; the same words mark the page. */
export function reportInteraction(words: string): void {
  setStatusNotice({
    id: INTERACTION_NOTICE,
    tone: "err",
    title: TITLE,
    body: words,
  });
}

export function clearInteractionNotice(): void {
  dismissNotice(INTERACTION_NOTICE);
}
