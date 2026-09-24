import type {
  ApprovalMechanism,
  InteractionDetail,
  InteractionStatus,
} from "@opensesame/os-domain";
import {
  INTERACTION_ERROR_WORDS,
  type InteractionErrorCode,
  interactionCodeForStatus,
} from "./interaction-error.js";
import { renderInteractionSummary } from "./interaction-summary.js";

/**
 * The words and endings of an interaction approval (ADR 0086), with no
 * surface in them. Moved out of `apps/mobile-mfa/src/approval.ts` so the phone
 * and Pages (ADR 0140 plan step 5) end the same question the same way: what
 * counts as settled, which authenticator is strong enough, which rendered line
 * is the one to compare with the other device, and what each refusal the
 * server names means for the person holding the screen.
 */

/**
 * How the question ended, as far as this screen is concerned.
 *
 * A closed set because three vocabularies arrive here — `InteractionStatus`,
 * the server's refusal codes and the link reader's verdict — and they describe
 * the same handful of endings. `refused` belongs to the *link* (it carried
 * credential material), not to any interaction.
 */
export type Outcome =
  | "approved"
  | "denied"
  | "consumed"
  | "expired"
  | "revoked"
  | "missing"
  | "refused";

/**
 * The word for each ending, in ADR 0061's voice. "Already used" rather than
 * "consumed": somebody spent the approval, possibly this person, a minute ago.
 */
export const OUTCOME_TEXT = {
  approved: "Approved",
  denied: "Denied",
  consumed: "Already used",
  expired: "Expired",
  revoked: "Withdrawn",
  missing: "Not found",
  refused: "Refused",
} as const satisfies Record<Outcome, string>;

/** A glyph beside each word, so an ending is never carried by colour alone. */
export const OUTCOME_MARK = {
  approved: "✓",
  denied: "✕",
  consumed: "◦",
  expired: "◦",
  revoked: "✕",
  missing: "?",
  refused: "✕",
} as const satisfies Record<Outcome, string>;

/** Whether an ending should read (and be announced) as a refusal. */
export const OUTCOME_IS_REFUSAL = {
  approved: false,
  denied: true,
  consumed: false,
  expired: true,
  revoked: true,
  missing: true,
  refused: true,
} as const satisfies Record<Outcome, boolean>;

/**
 * Settled statuses only. `pending`, `presented` and `awaiting_approval` produce
 * nothing: they are the states in which the screen *is* the question.
 */
export function outcomeOfStatus(
  status: InteractionStatus,
): Outcome | undefined {
  switch (status) {
    case "approved":
    case "denied":
    case "consumed":
    case "expired":
    case "revoked":
      return status;
    default:
      return undefined;
  }
}

/**
 * The client codes that mean the question is over. `digest_mismatch`,
 * `approval_required` and `rate_limited` end nothing: a rate limit read as
 * terminal would tell a person their request was settled when they should
 * just try again.
 */
export function outcomeOfErrorCode(
  code: InteractionErrorCode,
): Outcome | undefined {
  const refusal: InteractionRefusal = REFUSALS[code];
  return refusal.outcome;
}

/**
 * A step-up this device can perform. No `assurance` field: what an approval is
 * worth is the server's to decide, read off the activation it verified.
 */
export interface Mechanism {
  mechanism: ApprovalMechanism;
}

const PASSKEY: Mechanism = { mechanism: "webauthn" };

/**
 * WebAuthn or nothing. The authority requires a phishing-resistant,
 * interaction-scoped WebAuthn activation for an approval (ADR 0084, ADR 0086
 * §7): a bare session, even one freshly re-authenticated with a code, is not
 * an approval. `undefined` means this device cannot approve — offering a
 * weaker rung would step the person up to less than the request demands.
 */
export function chooseMechanism(
  webauthnAvailable: boolean,
): Mechanism | undefined {
  return webauthnAvailable ? PASSKEY : undefined;
}

/** The rendered interaction, split for layout. */
export interface ApprovalView {
  title: string;
  /** The binding message: the one string both devices show, to compare. */
  match?: string;
  facts: string[];
}

/**
 * Render an interaction for an approval screen. The binding message is found
 * by asking the kit's renderer again without it rather than re-deriving its
 * sanitising rule. Strings only, for text nodes: every value inside was chosen
 * by whoever asked for the approval.
 */
export function viewOf(detail: InteractionDetail): ApprovalView {
  const rendered = renderInteractionSummary(detail);
  const { bindingMessage: _binding, ...unbound } = detail;
  const withoutBinding = renderInteractionSummary(unbound);
  const [first, ...rest] = rendered.lines;
  const carriesBinding = rendered.lines.length > withoutBinding.lines.length;
  return carriesBinding && first !== undefined
    ? { title: rendered.title, match: first, facts: rest }
    : { title: rendered.title, facts: rendered.lines };
}

/* -------------------------------------------------------------- refusals */

/** What a refusal leaves the screen able to do. */
export type InteractionRefusalKind =
  /** The question is over; `outcome` says how. */
  | "ended"
  /** A decision already stands; read the interaction again to learn which. */
  | "settled"
  /** No accepted session behind the call. */
  | "signin"
  /** The request is no longer the one on screen. Nothing was approved. */
  | "changed"
  /** The passkey step did not verify. The question is still open. */
  | "stepup"
  /** The answer was refused as malformed or unsupported. Nothing changed. */
  | "rejected"
  /** A rate limit, a fault or an unreachable service: try again. */
  | "retry";

export type InteractionRefusal = {
  kind: InteractionRefusalKind;
  words: string;
  outcome?: Outcome;
};

export const INTERACTION_WORDS = {
  settled: "That request was already answered.",
  stepup: "The passkey was not confirmed. Nothing was approved. Try again.",
  rejected: "That answer was refused. Nothing was approved.",
  unanswerable: "This request carries nothing to approve.",
  sessionRefused: "That sign-in was not accepted. Sign in again.",
  signInFirst: "Sign in first.",
  linkRefused:
    "That link carried credential material. Start the request again from the device that asked.",
} as const;

const W = INTERACTION_ERROR_WORDS;

function ended(code: InteractionErrorCode, outcome: Outcome) {
  return { kind: "ended", words: W[code], outcome } as const;
}

const STEP_UP: InteractionRefusal = {
  kind: "stepup",
  words: INTERACTION_WORDS.stepup,
};
const REJECTED: InteractionRefusal = {
  kind: "rejected",
  words: INTERACTION_WORDS.rejected,
};

/**
 * Keyed on the code the server's body names
 * (`packages/control-plane/src/routes/interaction-handoff.ts` `ERRORS`, and
 * `interaction-activation.ts` for the `activation_*` family), then on the
 * client's own code. The body code outranks the status because one status
 * covers unrelated causes: 401 is `approval_required` (sign in),
 * `proof_required` or `activation_verification_failed` (the passkey step);
 * 409 is `digest_mismatch`, `interaction_settled` or `activation_not_pending`;
 * 404 and 410 are an activation's as often as the interaction's.
 */
const REFUSALS = {
  interaction_not_found: ended("interaction_not_found", "missing"),
  interaction_expired: ended("interaction_expired", "expired"),
  interaction_revoked: ended("interaction_revoked", "revoked"),
  interaction_consumed: ended("interaction_consumed", "consumed"),
  approval_denied: ended("approval_denied", "denied"),
  interaction_settled: { kind: "settled", words: INTERACTION_WORDS.settled },
  approval_required: { kind: "signin", words: W.approval_required },
  digest_mismatch: { kind: "changed", words: W.digest_mismatch },
  proof_required: STEP_UP,
  activation_not_found: STEP_UP,
  activation_expired: STEP_UP,
  activation_not_pending: STEP_UP,
  activation_challenge_mismatch: STEP_UP,
  activation_verification_failed: STEP_UP,
  invalid_request: REJECTED,
  unsupported_kind: REJECTED,
  rate_limited: { kind: "retry", words: W.rate_limited },
  interaction_unavailable: { kind: "retry", words: W.interaction_unavailable },
} as const satisfies Record<string, InteractionRefusal>;

type RefusalCode = keyof typeof REFUSALS;

function isRefusalCode(code: string): code is RefusalCode {
  return Object.hasOwn(REFUSALS, code);
}

/**
 * Word an interaction refusal: the body's code first, the status only when it
 * names none this table knows. Nothing from the response is ever the words.
 */
export function interactionRefusal(
  code: string,
  status: number,
): InteractionRefusal {
  return REFUSALS[
    isRefusalCode(code) ? code : interactionCodeForStatus(status)
  ];
}
