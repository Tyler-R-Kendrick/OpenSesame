/**
 * Map legacy VaultHeader wraps into ProtectionRecords without changing
 * derivation domains. A saved capabilityConnectors.encryption preference never
 * creates an enrolled protector (KP-04).
 */

import {
  type AuthenticatedLegacyGates,
  MANIFEST_SCHEMA_VERSION,
  type ProtectionRecord,
  type RootProtectionManifest,
  type VaultHeader,
} from "@opensesame/vault-core";
import {
  type VaultUnlocks,
  listPasskeyUnlockRecords,
} from "../unlock-methods.js";
import { webauthnRpId } from "../webauthn-host.js";
import { newProtectorId, newRootKeyId, newVaultId } from "./ids.js";

export type LegacyMigrationInput = {
  header: VaultHeader;
  /** Stable vault scope id when known; otherwise minted once for migration. */
  vaultId?: string;
  rootKeyId?: string;
  rootEpoch?: number;
  /**
   * RP id the legacy passkey wraps were enrolled under. Legacy records never
   * stored one — pre-migration ceremonies always used this origin's hostname —
   * so it defaults to the current ceremony origin.
   */
  passkeyRpId?: string;
};

export type LegacyMigrationResult = {
  manifest: Omit<RootProtectionManifest, "authB64">;
  /** True when records were projected from legacy wraps (weaker historical binding). */
  legacyBinding: true;
};

export function gatesFromUnlocks(
  unlocks: VaultUnlocks | undefined,
): AuthenticatedLegacyGates {
  return {
    totpEnrolled: unlocks?.totp !== undefined,
    emailEnrolled: unlocks?.email !== undefined,
    smsEnrolled: unlocks?.sms !== undefined,
    recoveryCodesEnrolled: unlocks?.recovery !== undefined,
  };
}

export function migrateLegacyHeaderToManifest(
  input: LegacyMigrationInput,
): LegacyMigrationResult {
  const { header } = input;
  const records: ProtectionRecord[] = [];

  if (header.kdf && header.wrap) {
    records.push({
      kind: "password",
      protectorId: newProtectorId("password"),
      legacy: true,
      kdf: {
        alg: "PBKDF2-SHA256",
        saltB64: header.kdf.saltB64,
        iterations: header.kdf.iterations,
      },
      wrap: { ivB64: header.wrap.ivB64, ctB64: header.wrap.ctB64 },
      proofStatus: "verified",
    });
  }

  if (header.unlocks?.pin) {
    records.push({
      kind: "pin",
      protectorId: newProtectorId("pin"),
      legacy: true,
      saltB64: header.unlocks.pin.kdf.saltB64,
      iterations: header.unlocks.pin.kdf.iterations,
      wrap: {
        ivB64: header.unlocks.pin.wrap.ivB64,
        ctB64: header.unlocks.pin.wrap.ctB64,
      },
      proofStatus: "verified",
    });
  }

  const passkeys = listPasskeyUnlockRecords(header.unlocks);
  const passkeyRpId = input.passkeyRpId ?? webauthnRpId();
  for (const passkey of passkeys) {
    records.push({
      kind: "webauthn-prf",
      protectorId: newProtectorId("webauthn-prf"),
      legacy: true,
      credentialIdB64: passkey.credentialIdB64,
      rpId: passkeyRpId,
      saltB64: passkey.prfSaltB64,
      wrap: {
        ivB64: passkey.wrap.ivB64,
        ctB64: passkey.wrap.ctB64,
      },
      userVerification: "preferred",
      proofStatus: "verified",
    });
  }

  const vaultId = input.vaultId ?? newVaultId();
  const rootKeyId = input.rootKeyId ?? newRootKeyId();
  const rootEpoch = input.rootEpoch ?? 0;

  return {
    legacyBinding: true,
    manifest: {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      vaultId,
      rootKeyId,
      rootEpoch,
      revision: 0,
      purpose: "human-vault-root",
      records,
      legacyGates: gatesFromUnlocks(header.unlocks),
    },
  };
}
