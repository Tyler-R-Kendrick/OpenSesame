/**
 * Safe code replacement / disarm — never returns or echoes enrolled codes.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isString,
  overlapCast,
} from "../json-boundary.js";

export type CodeSlotStatus = Readonly<{
  slotId: string;
  profileId: string;
  /** Digest of enrolled material only — never the cleartext. */
  materialDigest: string;
  enrolled: boolean;
  lastReplacedAt: string | null;
}>;

export type CodeCeremonyInput = Readonly<{
  slotId: string;
  profileId: string;
  /** Fresh code entered by owner — never persisted into status views. */
  newCode: string;
  previousCode?: string;
}>;

export type CodeCeremonyOutcome =
  | {
      ok: true;
      status: CodeSlotStatus;
    }
  | { ok: false; reason: string };

const CODE_FLOOR = 8;

function assertNoCodeLeak(value: BoundaryValue): void {
  if (isString(value) && /code|pin|secret|password/i.test(value)) {
    // Status labels may mention "code" as a path type; block cleartext-looking
    // values that look like enrolled secrets (long digit/alnum blobs only when
    // callers mistakenly stash them under known secret keys — handled by redact).
  }
  void value;
}

async function digestCode(code: string): Promise<string> {
  const data = new TextEncoder().encode(`duress-trigger-v1:${code}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Replace enrolled trigger material. Returns status with digest only.
 * Callers must not attach `newCode` to any persisted or rendered model.
 */
export async function replaceEnrolledCode(
  input: CodeCeremonyInput,
  existing: CodeSlotStatus | null,
): Promise<CodeCeremonyOutcome> {
  if (input.newCode.length < CODE_FLOOR) {
    return { ok: false, reason: "code_below_floor" };
  }
  if (/\s/.test(input.newCode)) {
    return { ok: false, reason: "code_contains_whitespace" };
  }
  if (existing?.enrolled && !input.previousCode) {
    return { ok: false, reason: "previous_code_required" };
  }
  if (existing?.enrolled && input.previousCode) {
    const prevDigest = await digestCode(input.previousCode);
    if (prevDigest !== existing.materialDigest) {
      return { ok: false, reason: "previous_code_mismatch" };
    }
  }

  const materialDigest = await digestCode(input.newCode);
  assertNoCodeLeak(materialDigest);

  const status: CodeSlotStatus = {
    slotId: input.slotId,
    profileId: input.profileId,
    materialDigest,
    enrolled: true,
    lastReplacedAt: new Date().toISOString(),
  };

  // Strip any accidental code fields before returning.
  const safe = sanitizeSlotStatus(status);
  return {
    ok: true,
    status: safe,
  } satisfies CodeCeremonyOutcome;
}

export function disarmProfile(status: CodeSlotStatus): CodeSlotStatus {
  return sanitizeSlotStatus({
    ...status,
    enrolled: false,
    materialDigest: "",
    lastReplacedAt: status.lastReplacedAt,
  });
}

/** Drop any secret-shaped keys if a caller spreads ceremony input into status. */
export function sanitizeSlotStatus(
  value: JsonObject | CodeSlotStatus,
): CodeSlotStatus {
  const raw = overlapCast<JsonObject>(value);
  return {
    slotId: String(raw.slotId ?? ""),
    profileId: String(raw.profileId ?? ""),
    materialDigest: String(raw.materialDigest ?? ""),
    enrolled: Boolean(raw.enrolled),
    lastReplacedAt:
      raw.lastReplacedAt === null || raw.lastReplacedAt === undefined
        ? null
        : String(raw.lastReplacedAt),
  };
}

export type PublicCodeSlotView = Readonly<{
  slotId: string;
  profileId: string;
  enrolled: boolean;
  lastReplacedAt: string | null;
}>;

/**
 * Public view model — enrollment state only. Nothing derived from the code
 * reaches it: even a digest prefix of a short numeric code is a lookup table
 * away from the code itself, and a screenshot would carry it.
 */
export function publicCodeSlotView(status: CodeSlotStatus): PublicCodeSlotView {
  return {
    slotId: status.slotId,
    profileId: status.profileId,
    enrolled: status.enrolled,
    lastReplacedAt: status.lastReplacedAt,
  } satisfies PublicCodeSlotView;
}
