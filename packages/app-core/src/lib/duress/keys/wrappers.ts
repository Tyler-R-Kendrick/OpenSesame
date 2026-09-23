/**
 * Inventory of unlock wrappers that may admit vault material (KEYS-A/C).
 * Shared-root wrappers are never claimed as cryptographic isolation (INV-05).
 */

export type WrapperKind =
  | "password"
  | "pin"
  | "webauthn_prf"
  | "legacy_wrap"
  | "recovery_key"
  | "age"
  | "sops"
  | "cloud_envelope";

export type WrapperInventoryEntry = Readonly<{
  kind: WrapperKind;
  label: string;
  /** True when this path can open a protected root without the duress code. */
  admitsProtectedRootAlone: boolean;
  /** True when independently keyed compartment isolation is claimed. */
  independentCompartment: boolean;
  /** Honest residual: historical ciphertext may still open with this key. */
  historicalCopyRisk: boolean;
}>;

/**
 * Static catalog of wrapper classes known to Pages vault protection.
 * Callers supply which kinds are actually enrolled for a vault.
 */
export const WRAPPER_CATALOG = {
  password: {
    label: "Master password wrap",
    admitsProtectedRootAlone: true,
    independentCompartment: false,
    historicalCopyRisk: true,
  },
  pin: {
    label: "PIN wrap (PBKDF2 floor)",
    admitsProtectedRootAlone: true,
    independentCompartment: false,
    historicalCopyRisk: true,
  },
  webauthn_prf: {
    label: "WebAuthn PRF wrap",
    admitsProtectedRootAlone: true,
    independentCompartment: false,
    historicalCopyRisk: true,
  },
  legacy_wrap: {
    label: "Legacy header wrap",
    admitsProtectedRootAlone: true,
    independentCompartment: false,
    historicalCopyRisk: true,
  },
  recovery_key: {
    label: "Recovery key",
    admitsProtectedRootAlone: true,
    independentCompartment: false,
    historicalCopyRisk: true,
  },
  age: {
    label: "age recipient wrap",
    admitsProtectedRootAlone: true,
    independentCompartment: false,
    historicalCopyRisk: true,
  },
  sops: {
    label: "SOPS sealed secret",
    admitsProtectedRootAlone: true,
    independentCompartment: false,
    historicalCopyRisk: true,
  },
  cloud_envelope: {
    label: "Cloud envelope bootstrap",
    admitsProtectedRootAlone: true,
    independentCompartment: false,
    historicalCopyRisk: true,
  },
} satisfies Readonly<Record<WrapperKind, Omit<WrapperInventoryEntry, "kind">>>;

export function inventoryWrappers(
  enrolled: readonly WrapperKind[],
): WrapperInventoryEntry[] {
  const unique = [...new Set(enrolled)];
  return unique.map((kind) => ({ kind, ...WRAPPER_CATALOG[kind] }));
}

/** Durable signals readable from a vault header / protection manifest. */
export type VaultWrapperSignals = Readonly<{
  hasPasswordWrap?: boolean;
  hasPin?: boolean;
  hasPasskeyPrf?: boolean;
  hasLegacyWrap?: boolean;
  hasRecoveryKey?: boolean;
  hasAgeRecipient?: boolean;
  hasSops?: boolean;
  hasCloudEnvelope?: boolean;
}>;

export function inventoryFromVaultSignals(
  signals: VaultWrapperSignals,
): WrapperInventoryEntry[] {
  const kinds: WrapperKind[] = [];
  if (signals.hasPasswordWrap) kinds.push("password");
  if (signals.hasPin) kinds.push("pin");
  if (signals.hasPasskeyPrf) kinds.push("webauthn_prf");
  if (signals.hasLegacyWrap) kinds.push("legacy_wrap");
  if (signals.hasRecoveryKey) kinds.push("recovery_key");
  if (signals.hasAgeRecipient) kinds.push("age");
  if (signals.hasSops) kinds.push("sops");
  if (signals.hasCloudEnvelope) kinds.push("cloud_envelope");
  return inventoryWrappers(kinds);
}

/**
 * Disclose alternate wrappers that survive a claimed two-input / hold path.
 * Never silently downgrade — callers must surface these in exposure UI.
 */
export function survivingAlternateWrappers(
  enrolled: readonly WrapperKind[],
  claim: { twoInputRequired: boolean; holdActive: boolean },
): string[] {
  if (!claim.twoInputRequired && !claim.holdActive) return [];
  return inventoryWrappers(enrolled)
    .filter((w) => w.admitsProtectedRootAlone)
    .map(
      (w) =>
        `${w.label}: still admits protected root without the enrolled duress inputs`,
    );
}

export function assertNoSilentBypass(
  enrolled: readonly WrapperKind[],
  claim: { twoInputRequired: boolean; holdActive: boolean },
): void {
  const warnings = survivingAlternateWrappers(enrolled, claim);
  if (warnings.length > 0 && claim.twoInputRequired) {
    throw new Error(
      `alternate_unlock_bypass: ${warnings.length} surviving wrapper(s)`,
    );
  }
}
