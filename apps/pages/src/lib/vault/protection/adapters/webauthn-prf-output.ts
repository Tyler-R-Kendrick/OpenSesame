/**
 * WebAuthn PRF extension result parsing and KEK-readiness checks (KP-22).
 * Shared by unlock-methods and the PRF ceremony adapter — no ceremony I/O.
 */

import { overlapCast } from "@opensesame/os-domain";

type PrfExtensionOutput = {
  enabled?: boolean;
  results?: { first?: ArrayBuffer };
};

/** WebAuthn PRF outputs are 32-byte HMAC values; shorter buffers are not KEKs. */
export const MIN_PRF_OUTPUT_BYTES = 32;

export type PrfCeremonyErrorCode =
  | "canceled"
  | "wrong_credential"
  | "wrong_rp"
  | "origin_mismatch"
  | "prf_enabled_without_output"
  | "prf_missing_output"
  | "prf_output_too_short"
  | "unsupported"
  | "invalid_host";

export class PrfCeremonyError extends Error {
  readonly code: PrfCeremonyErrorCode;
  constructor(code: PrfCeremonyErrorCode, message: string) {
    super(message);
    this.name = "PrfCeremonyError";
    this.code = code;
  }
}

export function prfExtensionSupported(
  results: AuthenticationExtensionsClientOutputs | undefined,
): boolean {
  const prf: PrfExtensionOutput | undefined = overlapCast(results?.prf);
  // `enabled` only means the extension ran — not that a KEK can be derived.
  return Boolean(prf?.results?.first || prf?.enabled);
}

export function readPrfFirst(
  results: AuthenticationExtensionsClientOutputs | undefined,
): ArrayBuffer | null {
  const prf: PrfExtensionOutput | undefined = overlapCast(results?.prf);
  return prf?.results?.first ?? null;
}

/** True only when `results.first` has a usable PRF byte length. `enabled` alone is false. */
export function hasUsablePrfOutput(
  results: AuthenticationExtensionsClientOutputs | undefined,
): boolean {
  const first = readPrfFirst(results);
  return first !== null && first.byteLength >= MIN_PRF_OUTPUT_BYTES;
}

/** KP-22: refuse to treat enabled-without-results or short buffers as a KEK. */
export function assertUsablePrfOutput(prfOutput: ArrayBuffer): void {
  if (prfOutput.byteLength < MIN_PRF_OUTPUT_BYTES) {
    throw new PrfCeremonyError(
      "prf_output_too_short",
      `WebAuthn PRF output must be at least ${MIN_PRF_OUTPUT_BYTES} bytes before it can wrap a vault key.`,
    );
  }
}

export function requirePrfOutputFromExtension(
  results: AuthenticationExtensionsClientOutputs | undefined,
): ArrayBuffer {
  const prf: PrfExtensionOutput | undefined = overlapCast(results?.prf);
  const first = prf?.results?.first;
  if (!first) {
    if (prf?.enabled) {
      throw new PrfCeremonyError(
        "prf_enabled_without_output",
        "This authenticator reported PRF enabled but returned no output. That is not a key — finish assertion, or use a PIN / password.",
      );
    }
    throw new PrfCeremonyError(
      "prf_missing_output",
      "This authenticator did not return a WebAuthn PRF result. Use a platform passkey that supports PRF, or unlock with a PIN / password.",
    );
  }
  assertUsablePrfOutput(first);
  return first;
}
