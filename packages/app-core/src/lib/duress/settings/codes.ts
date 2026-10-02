/**
 * Safe code replacement / disarm — never returns or echoes enrolled codes.
 */

import { type JsonObject, overlapCast } from "../json-boundary.js";

export type CodeSlotStatus = Readonly<{
  slotId: string;
  profileId: string;
  /** Salted PBKDF2 digest of enrolled material — never the cleartext. */
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
const DIGEST_ALGORITHM = "pbkdf2-sha256";
const DIGEST_ITERATIONS = 600_000;
const DIGEST_DOMAIN = "duress-trigger-v1:";
const LEGACY_DIGEST = /^[0-9a-f]{64}$/;

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function unhex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function deriveCodeDigest(
  code: string,
  salt: Uint8Array,
  iterations: number,
): Promise<string> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${DIGEST_DOMAIN}${code}`),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: overlapCast(salt), iterations, hash: "SHA-256" },
    material,
    256,
  );
  return hex(new Uint8Array(bits));
}

async function digestNewCode(code: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await deriveCodeDigest(code, salt, DIGEST_ITERATIONS);
  return `${DIGEST_ALGORITHM}:${DIGEST_ITERATIONS}:${hex(salt)}:${digest}`;
}

async function codeMatchesDigest(
  code: string,
  recorded: string,
): Promise<boolean> {
  const parts = recorded.split(":");
  if (parts[0] === DIGEST_ALGORITHM && parts.length === 4) {
    const [, rawIterations, rawSalt, expected] = parts;
    const iterations = Number(rawIterations);
    if (
      !expected ||
      !rawSalt ||
      !/^[0-9a-f]+$/.test(rawSalt) ||
      !Number.isInteger(iterations) ||
      iterations <= 0
    ) {
      return false;
    }
    return (
      (await deriveCodeDigest(code, unhex(rawSalt), iterations)) === expected
    );
  }
  // Statuses minted before the salted KDF carry a bare SHA-256 hex digest;
  // accept one so an enrolled code stays replaceable, then re-digest on write.
  if (LEGACY_DIGEST.test(recorded)) {
    const data = new TextEncoder().encode(`${DIGEST_DOMAIN}${code}`);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return hex(new Uint8Array(digest)) === recorded;
  }
  return false;
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
    if (
      !(await codeMatchesDigest(input.previousCode, existing.materialDigest))
    ) {
      return { ok: false, reason: "previous_code_mismatch" };
    }
  }

  const materialDigest = await digestNewCode(input.newCode);

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
 * reaches it: the salted digest stays in the internal status, and a
 * screenshot would carry anything shown here.
 */
export function publicCodeSlotView(status: CodeSlotStatus): PublicCodeSlotView {
  return {
    slotId: status.slotId,
    profileId: status.profileId,
    enrolled: status.enrolled,
    lastReplacedAt: status.lastReplacedAt,
  } satisfies PublicCodeSlotView;
}
