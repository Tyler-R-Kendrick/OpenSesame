/**
 * The Identity API's authorization-request refusals, in plain words (ADR
 * 0084; ADR 0140 plan step 6).
 *
 * Keyed on the error code the body names first and on the status only when it
 * names none, as `claimRefusal` and `interactionRefusal` are. One status
 * covers unrelated causes on these routes (`routes/authorization-requests.ts`):
 * a 403 is `comparison_required`, `assurance_insufficient`, a revoked binding
 * or a request that is not yours; a 409 is a changed digest, a wrong
 * comparison code, a spent activation or a lost race; a 410 is an expired
 * request, an expired activation or an expired comparison code; a 401 is a
 * missing session or an assertion the server would not verify. Reading any of
 * those by status alone tells a person to do the wrong next thing — "sign in"
 * after a passkey touch was refused, "not yours" after the policy asked for
 * more, "expired" when only the code lapsed.
 *
 * Every sentence says what happened to the *request*, because "nothing was
 * decided" is the fact somebody standing at the screen needs.
 */

export type ApprovalRefusalKind =
  /** No session behind the call; sign in and come back. */
  | "signin"
  /** The request is addressed to someone else. */
  | "not_yours"
  | "not_found"
  | "expired"
  /** What was shown is not what is stored. */
  | "changed"
  /** The destination this link came through was revoked. */
  | "revoked"
  | "already_decided"
  /** The state moved during the decision (two approvers, a double press). */
  | "conflict"
  /** The rules for this request changed while it was being decided. */
  | "policy_changed"
  /** The passkey touch took too long or its activation is gone. */
  | "activation_expired"
  /** The passkey touch was not accepted for this request. */
  | "activation_failed"
  /** The comparison code did not match: a security signal, not a typo. */
  | "comparison_mismatch"
  | "comparison_exhausted"
  | "comparison_expired"
  /** No comparison code was presented, or none was ever issued. */
  | "comparison_required"
  /** This sign-in cannot meet what the policy demands. */
  | "assurance"
  /** Refused as malformed; nothing was spent. */
  | "rejected"
  /** Too many prompts or a server that could not answer: try again later. */
  | "unavailable"
  /** Nothing reached the server. */
  | "unreachable"
  | "failed";

export type ApprovalRefusal = {
  kind: ApprovalRefusalKind;
  words: string;
  /** Nothing is left to try: the surface stops offering a decision. */
  ends: boolean;
};

/** Words for the comparison mismatch. A security signal, not a form error. */
export const COMPARISON_MISMATCH =
  "That code doesn't match. Someone else may have started this request. Do not approve it — check with whoever you think asked, and deny it if nobody did.";

const WORDS: Record<ApprovalRefusalKind, Omit<ApprovalRefusal, "kind">> = {
  signin: {
    words: "Sign in to decide requests addressed to you.",
    ends: false,
  },
  not_yours: {
    words:
      "This request is not addressed to you, so it is not yours to decide.",
    ends: false,
  },
  not_found: {
    words:
      "This link does not point at a request we can find. It may have been withdrawn. Ask whoever sent it for a fresh one.",
    ends: true,
  },
  expired: {
    words:
      "This request expired before it was decided. Nothing was approved — whoever asked will have to ask again.",
    ends: true,
  },
  changed: {
    words:
      "This request changed since it was shown, so nothing was decided. Reload it and read the new version before deciding.",
    ends: true,
  },
  revoked: {
    words:
      "The destination this request was sent to has been revoked, so it can no longer be decided from that link. Nothing was decided.",
    ends: true,
  },
  already_decided: {
    words: "This request was already decided. Nothing changed just now.",
    ends: true,
  },
  conflict: {
    words:
      "This request moved while you were deciding — it may have been decided somewhere else. Nothing changed from here; reload it to see where it stands.",
    ends: false,
  },
  policy_changed: {
    words:
      "The rules for this request changed while you were deciding, so nothing was decided. Read it again before deciding.",
    ends: false,
  },
  activation_expired: {
    words:
      "Your authenticator touch took too long, so it was not accepted and nothing was decided. Read the request again and touch your passkey once more.",
    ends: false,
  },
  activation_failed: {
    words:
      "Your passkey touch was not accepted for this request, so nothing was decided. Read the request again and touch your passkey once more.",
    ends: false,
  },
  comparison_mismatch: { words: COMPARISON_MISMATCH, ends: false },
  comparison_exhausted: {
    words:
      "Too many wrong codes, so this request is locked and nothing was decided. Ask whoever started it to begin again.",
    ends: false,
  },
  comparison_expired: {
    words:
      "The six-digit code for this request expired, so nothing was decided. Ask whoever started it to begin again.",
    ends: false,
  },
  comparison_required: {
    words:
      "This request needs the six-digit code shown where it started, and none was accepted. Nothing was decided.",
    ends: false,
  },
  assurance: {
    words:
      "This request needs more proof than this sign-in can give, so nothing was decided. Open it where you can touch a passkey registered with OpenSesame.",
    ends: false,
  },
  rejected: {
    words: "That was refused as malformed. Nothing was decided.",
    ends: false,
  },
  unavailable: {
    words: "The request could not be reached just now. Try again in a moment.",
    ends: false,
  },
  unreachable: {
    words: "The Identity API is not reachable from here. Nothing was decided.",
    ends: false,
  },
  failed: { words: "That did not go through.", ends: false },
};

const BY_CODE: Readonly<Record<string, ApprovalRefusalKind>> = {
  unauthorized: "signin",
  forbidden: "not_yours",
  approver_mismatch: "not_yours",
  not_found: "not_found",
  expired: "expired",
  expired_request: "expired",
  digest_mismatch: "changed",
  request_digest_changed: "changed",
  binding_revoked: "revoked",
  binding_not_usable: "revoked",
  request_not_pending: "already_decided",
  invalid_transition: "already_decided",
  conflict: "conflict",
  activation_policy_changed: "policy_changed",
  activation_expired: "activation_expired",
  activation_not_found: "activation_expired",
  comparison_mismatch: "comparison_mismatch",
  comparison_exhausted: "comparison_exhausted",
  comparison_expired: "comparison_expired",
  comparison_required: "comparison_required",
  comparison_not_found: "comparison_required",
  comparison_already_satisfied: "conflict",
  assurance_insufficient: "assurance",
  channel_cannot_meet_assurance: "assurance",
  approval_requirements_unmet: "assurance",
  invalid_request: "rejected",
  prompt_rate_limited: "unavailable",
  slow_down: "unavailable",
};

function kindOfCode(code: string): ApprovalRefusalKind | undefined {
  if (Object.hasOwn(BY_CODE, code)) return BY_CODE[code];
  // Every other `activation_*` refusal (`activation_not_pending`,
  // `activation_already_consumed`, `activation_wrong_decision`,
  // `activation_challenge_mismatch`, `activation_verification_failed`, …)
  // is the passkey step failing — never a sign-in, never a changed request.
  if (code.startsWith("activation_")) return "activation_failed";
  if (code.startsWith("comparison_")) return "comparison_required";
  return undefined;
}

function kindOfStatus(status: number): ApprovalRefusalKind {
  if (status === 0) return "unreachable";
  if (status === 401) return "signin";
  if (status === 403) return "not_yours";
  if (status === 404) return "not_found";
  if (status === 409) return "changed";
  if (status === 410) return "expired";
  if (status === 422) return "already_decided";
  if (status === 429 || status >= 500) return "unavailable";
  return "failed";
}

/** The refusal for a response: the body's code first, then the status. */
export function approvalRefusal(code: string, status: number): ApprovalRefusal {
  const kind = kindOfCode(code) ?? kindOfStatus(status);
  const { words, ends } = WORDS[kind];
  const said =
    kind === "failed" && status > 0
      ? `${words.slice(0, -1)} (${status}).`
      : words;
  return { kind, words: said, ends };
}

/** Words and ending for a refusal kind, where no response carried one. */
export function approvalWords(kind: ApprovalRefusalKind): ApprovalRefusal {
  return { kind, ...WORDS[kind] };
}

/**
 * A refused authorization-request call, worded. `declared` keeps the body's
 * error code as a key for a surface that branches on it — never as text.
 */
export class ApprovalError extends Error {
  readonly kind: ApprovalRefusalKind;
  readonly ends: boolean;
  readonly status: number;
  readonly declared: string;
  constructor(refusal: ApprovalRefusal, status = 0, declared = "") {
    super(refusal.words);
    this.name = "ApprovalError";
    this.kind = refusal.kind;
    this.ends = refusal.ends;
    this.status = status;
    this.declared = declared;
  }
}
