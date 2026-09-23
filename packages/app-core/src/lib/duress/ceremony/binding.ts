/**
 * Origin / credential binding checks for PRF and UV ceremonies (TRIGGER-F).
 */

export type CeremonyBinding = Readonly<{
  origin: string;
  expectedOrigin: string;
  credentialIdB64?: string;
  expectedCredentialIdB64?: string;
}>;

export type BindingResult =
  | { ok: true }
  | { ok: false; reason: "wrong_origin" | "wrong_credential" | "missing_prf" };

export function checkCeremonyBinding(binding: CeremonyBinding): BindingResult {
  if (binding.origin !== binding.expectedOrigin) {
    return { ok: false, reason: "wrong_origin" };
  }
  if (
    binding.expectedCredentialIdB64 !== undefined &&
    binding.credentialIdB64 !== binding.expectedCredentialIdB64
  ) {
    return { ok: false, reason: "wrong_credential" };
  }
  return { ok: true };
}

export function assertCeremonyBinding(binding: CeremonyBinding): void {
  const result = checkCeremonyBinding(binding);
  if (!result.ok) {
    throw new Error(`unsupported_factor: ${result.reason}`);
  }
}

export function assertPrfPresent(
  prfOutput: Uint8Array | null | undefined,
  minBytes = 32,
): void {
  if (!prfOutput || prfOutput.length < minBytes) {
    throw new Error("unsupported_factor: missing PRF output");
  }
}
