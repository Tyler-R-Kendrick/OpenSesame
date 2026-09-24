/**
 * The Identity API's claim refusals, in plain words.
 *
 * Keyed on the error code the body names first and on the status only when it
 * names none, as `deviceApprovalWords` is: one status covers unrelated causes
 * here too. A 401 from `/v1/claims/:id/complete` is `invalid_user_code` (type
 * the code again), `invalid_claim_token` (this link is finished) or
 * `unauthorized` (sign in again; the claim is waiting) — reading all three as
 * "spent" is how a mistyped consent code used to throw a presented claim away.
 *
 * The codes are the server's (`packages/control-plane/src/routes/claims.ts`):
 * its own lower-case ones, and `DomainError` codes passed through in capitals.
 */

/** What became of the claim, so a surface knows what to offer next. */
export type ClaimRefusalKind =
  /** The consent code did not match; the claim is still open. */
  | "wrong_code"
  /** Too many wrong codes; the claim will refuse every further attempt. */
  | "locked_out"
  /** No principal behind the request; sign in and resume. */
  | "signed_out"
  | "expired"
  /** Completed, denied, or otherwise moved on. */
  | "decided"
  /** The bearer is unknown, malformed or does not open this claim. */
  | "invalid"
  /** The request itself was refused as malformed; nothing was spent. */
  | "rejected"
  /** Anything a retry might fix: overload, a server fault, a rate limit. */
  | "unavailable";

export type ClaimRefusal = {
  kind: ClaimRefusalKind;
  words: string;
  /** Whether retrying with the same bearer could never succeed. */
  spent: boolean;
};

const REFUSALS: Record<ClaimRefusalKind, Omit<ClaimRefusal, "kind">> = {
  wrong_code: {
    words:
      "That code did not match this claim. Check it with the person who shared it and try again.",
    spent: false,
  },
  locked_out: {
    words: "Too many wrong codes. Ask for a fresh claim link.",
    spent: true,
  },
  signed_out: {
    words: "Sign in again to finish this claim. It is waiting, not lost.",
    spent: false,
  },
  expired: { words: "This claim expired. Ask for a fresh one.", spent: true },
  decided: { words: "This claim has already been decided.", spent: true },
  invalid: {
    words: "This claim link is no longer valid. Ask for a fresh one.",
    spent: true,
  },
  rejected: {
    words:
      "That request was refused as malformed. Check the code and try again.",
    spent: false,
  },
  unavailable: {
    words: "The claim could not be reached just now. Try again.",
    spent: false,
  },
};

const BY_CODE: Readonly<Record<string, ClaimRefusalKind>> = {
  invalid_user_code: "wrong_code",
  INVALID_USER_CODE: "wrong_code",
  too_many_attempts: "locked_out",
  unauthorized: "signed_out",
  EXPIRED: "expired",
  INVALID_TRANSITION: "decided",
  CONFLICT: "decided",
  DEPENDENCY_CLOSURE: "decided",
  INVARIANT_VIOLATION: "decided",
  IMMUTABLE_FIELD: "decided",
  invalid_token: "invalid",
  invalid_claim_token: "invalid",
  INVALID_TOKEN: "invalid",
  not_found: "invalid",
  NOT_FOUND: "invalid",
  validation_error: "rejected",
};

function kindByStatus(status: number): ClaimRefusalKind {
  if (status === 410) return "expired";
  if (status === 409 || status === 422) return "decided";
  if (status === 401 || status === 404) return "invalid";
  if (status === 400) return "rejected";
  return "unavailable";
}

/**
 * Word a claim refusal. `detail` (the body's `message` or `hint`) is used only
 * for a failure the table cannot name — a server fault says what went wrong in
 * its own words, but a known refusal is always worded the same way.
 */
export function claimRefusal(
  code: string,
  status: number,
  detail: string | null = null,
): ClaimRefusal {
  const kind = BY_CODE[code] ?? kindByStatus(status);
  const refusal = REFUSALS[kind];
  const words = kind === "unavailable" && detail ? detail : refusal.words;
  return { kind, words, spent: refusal.spent };
}

/* ----------------------------------------------------------------- drops */

/** A drop recipient's view of a refused presentation. */
export type DropRefusalCode =
  | "invalid_code"
  | "already_opened"
  | "expired"
  | "invalid"
  | "unreachable";

export type DropRefusal = { code: DropRefusalCode; words: string };

const DROP_WORDS: Record<Exclude<DropRefusalCode, "unreachable">, string> = {
  invalid_code:
    "That code did not match this drop. Check it with the sender and try again.",
  already_opened: "This drop was already opened.",
  expired: "This drop expired before it was opened.",
  invalid: "This drop link is not valid. Ask the sender for a fresh one.",
};

const DROP_BY_CODE: Readonly<Record<string, DropRefusalCode>> = {
  invalid_user_code: "invalid_code",
  too_many_attempts: "invalid_code",
  EXPIRED: "expired",
  // The single-use transition refused a second presentation.
  INVALID_TRANSITION: "already_opened",
  CONFLICT: "already_opened",
  invalid_token: "invalid",
  INVALID_TOKEN: "invalid",
  not_found: "invalid",
  NOT_FOUND: "invalid",
};

function dropCodeByStatus(status: number): DropRefusalCode {
  if (status === 410) return "expired";
  if (status === 422 || status === 409) return "already_opened";
  if (status === 401 || status === 404) return "invalid";
  return "unreachable";
}

/**
 * Word a refused drop presentation (`POST /v1/claims/present` with a user
 * code). A wrong code does not burn the drop — the server checks it before the
 * single-use transition — so it reads as "try again", never as "gone".
 *
 * The body's code picks what happened, the status only when it names none.
 * `detail` is the hint the answering plane wrote for a person: the Identity
 * API writes none on this route, while the device-local claim plane
 * (`app-core/lib/vault/local-drop-claims.ts`) says precisely what it refused
 * — "this drop is not on this device" — so its words are kept.
 */
export function dropRefusal(
  code: string,
  status: number,
  detail: string | null = null,
): DropRefusal {
  const kind = DROP_BY_CODE[code] ?? dropCodeByStatus(status);
  if (detail) return { code: kind, words: detail };
  if (code === "too_many_attempts") {
    return {
      code: kind,
      words: "Too many wrong codes. Ask the sender for a fresh drop.",
    };
  }
  if (kind === "unreachable") {
    return { code: kind, words: `Opening the drop failed (${status}).` };
  }
  return { code: kind, words: DROP_WORDS[kind] };
}
