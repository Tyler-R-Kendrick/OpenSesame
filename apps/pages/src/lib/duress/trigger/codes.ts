/**
 * Trigger code shape + digests (TRIGGER).
 * Leading zeros are significant; reverse-PIN is never a convention.
 */

import {
  DURESS_PIN_MAX,
  DURESS_PIN_MIN,
  assertTriggerCodeLength,
} from "../crypto/slots.js";

export { assertTriggerCodeLength, DURESS_PIN_MAX, DURESS_PIN_MIN };

/** SHA-256 hex of the exact code string (leading zeros preserved). */
export async function fingerprintCode(code: string): Promise<string> {
  const dig = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(code),
  );
  return [...new Uint8Array(dig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Digit-reverse of a numeric code string — never used as an implied duress code. */
export function reverseDigits(code: string): string {
  return [...code].reverse().join("");
}

/**
 * Refuse the reverse-PIN convention: enrolling reverse(ordinary) as the
 * duress code is not a supported shortcut (INV / TRIGGER-F).
 */
export function assertNotReversePinConvention(
  candidate: string,
  ordinaryCode: string | undefined,
): void {
  if (!ordinaryCode) return;
  if (candidate === reverseDigits(ordinaryCode)) {
    throw new Error(
      "unsupported_factor: reverse-PIN convention is not supported",
    );
  }
}

/** True when `candidate` equals `ordinary` with exact digit string equality. */
export function codesCollideExactly(
  candidate: string,
  ordinary: string,
): boolean {
  return candidate === ordinary;
}
