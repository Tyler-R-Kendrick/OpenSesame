/**
 * Manifest mutation helpers for preferred / remove / test / rotate (BROWSER).
 */

import {
  MANIFEST_SCHEMA_VERSION,
  type PasswordProtectorRecord,
  type ProtectionRecord,
  type RecoveryKeyProtectorRecord,
  type RootProtectionManifest,
  type VaultHeader,
  mintVaultKey,
  wrapVaultKeyWithPassword,
} from "@opensesame/vault-core";
import { assertNewPassword } from "../unlock-secret-guard.js";
import { ProtectionError } from "./errors.js";
import { newOpaqueId, newProtectorId } from "./ids.js";
import {
  assertCanRemoveProtector,
  assertExpectedRevision,
} from "./lifecycle.js";
import { sealAuthenticatedManifest } from "./manifest-auth.js";
import { migrateLegacyHeaderToManifest } from "./migrate-legacy.js";
import { openWithRecoveryKey } from "./recovery-key.js";

export type LifecycleHost = {
  getHeader(): VaultHeader | null;
  requireRawRoot(): Uint8Array;
  persistHeader(next: VaultHeader): Promise<void>;
  /** Replace in-memory raw VK + re-seal body under the new key. */
  replaceRawVaultKey(next: Uint8Array): Promise<void>;
};

function requireManifest(header: VaultHeader): RootProtectionManifest {
  if (header.protection) return header.protection;
  return migrateLegacyHeaderToManifest({ header }).manifest;
}

function contextFor(manifest: RootProtectionManifest, protectorId: string) {
  return {
    vaultId: manifest.vaultId,
    rootKeyId: manifest.rootKeyId,
    rootEpoch: manifest.rootEpoch,
    protectorId,
    purpose: manifest.purpose,
  };
}

export async function setPreferredProtector(
  host: LifecycleHost,
  protectorId: string,
): Promise<void> {
  const header = host.getHeader();
  if (!header) {
    throw new ProtectionError(
      "unavailable",
      "There is no vault header on this device.",
    );
  }
  const base = requireManifest(header);
  assertExpectedRevision(base, base.revision);
  if (!base.records.some((r) => r.protectorId === protectorId)) {
    throw new ProtectionError(
      "malformed_encoding",
      `Protector ${protectorId} is not enrolled.`,
    );
  }
  const { authB64: _drop, ...rest } = base;
  const nextBody: Omit<RootProtectionManifest, "authB64"> = {
    ...rest,
    revision: base.revision + 1,
    preferredProtectorId: protectorId,
  };
  const sealed = await sealAuthenticatedManifest(
    host.requireRawRoot(),
    nextBody,
  );
  await host.persistHeader({ ...header, protection: sealed });
}

export async function removeProtector(
  host: LifecycleHost,
  protectorId: string,
): Promise<void> {
  const header = host.getHeader();
  if (!header) {
    throw new ProtectionError(
      "unavailable",
      "There is no vault header on this device.",
    );
  }
  const base = requireManifest(header);
  assertCanRemoveProtector(base, protectorId);
  assertExpectedRevision(base, base.revision);
  const { authB64: _drop, preferredProtectorId: _pref, ...rest } = base;
  const nextBody: Omit<RootProtectionManifest, "authB64"> = {
    ...rest,
    revision: base.revision + 1,
    records: base.records.filter((r) => r.protectorId !== protectorId),
  };
  if (
    base.preferredProtectorId !== undefined &&
    base.preferredProtectorId !== protectorId
  ) {
    nextBody.preferredProtectorId = base.preferredProtectorId;
  }
  const sealed = await sealAuthenticatedManifest(
    host.requireRawRoot(),
    nextBody,
  );
  await host.persistHeader({ ...header, protection: sealed });
}

/**
 * Re-prove a recovery-key protector when the operator supplies the secret.
 * Password/PIN/PRF records that match live unlock wraps stay verified.
 */
export async function testProtector(
  host: LifecycleHost,
  protectorId: string,
  material?: { recoverySecretB64?: string },
): Promise<ProtectionRecord> {
  const header = host.getHeader();
  if (!header) {
    throw new ProtectionError(
      "unavailable",
      "There is no vault header on this device.",
    );
  }
  const base = requireManifest(header);
  const record = base.records.find((r) => r.protectorId === protectorId);
  if (!record) {
    throw new ProtectionError(
      "malformed_encoding",
      `Protector ${protectorId} is not enrolled.`,
    );
  }
  if (record.kind === "recovery-key") {
    const secret = material?.recoverySecretB64;
    if (!secret) {
      throw new ProtectionError(
        "unavailable",
        "Recovery-key test requires the shown-once secret.",
      );
    }
    // SAFETY: record.kind === "recovery-key" checked above; RecoveryKeyProtectorRecord contract established.
    const recovery = record as RecoveryKeyProtectorRecord;
    const opened = await openWithRecoveryKey({
      context: contextFor(base, recovery.protectorId),
      record: recovery,
      secretB64: secret,
    });
    opened.fill(0);
  } else if (
    record.kind === "password" ||
    record.kind === "pin" ||
    record.kind === "webauthn-prf"
  ) {
    throw new ProtectionError(
      "unavailable",
      "Password, PIN, and passkey proofs require their unlock ceremony — open the vault with that method instead of Test.",
    );
  } else if (record.proofStatus !== "verified") {
    throw new ProtectionError(
      "unavailable",
      `Protector kind ${record.kind} cannot be tested without its adapter ceremony.`,
    );
  }

  const updated: ProtectionRecord = {
    ...record,
    proofStatus: "verified",
  };
  const { authB64: _drop, ...rest } = base;
  const nextBody: Omit<RootProtectionManifest, "authB64"> = {
    ...rest,
    revision: base.revision + 1,
    records: base.records.map((r) =>
      r.protectorId === protectorId ? updated : r,
    ),
  };
  const sealed = await sealAuthenticatedManifest(
    host.requireRawRoot(),
    nextBody,
  );
  await host.persistHeader({ ...header, protection: sealed });
  return updated;
}

/**
 * Mint a new vault root, re-seal the body, re-wrap with password, and reset
 * the protection manifest to the password path (root-rotate).
 *
 * The new password meets the same floor as every other master-password path
 * (policy, then the duress-code collision probe) before any key changes.
 */
export async function rotateCompromisedRoot(
  host: LifecycleHost,
  input: { password: string },
): Promise<void> {
  await assertNewPassword(input.password);
  const header = host.getHeader();
  if (!header) {
    throw new ProtectionError(
      "unavailable",
      "There is no vault header on this device.",
    );
  }
  const base = requireManifest(header);
  const { rawVaultKey } = await mintVaultKey();
  await host.replaceRawVaultKey(rawVaultKey);
  const wrapped = await wrapVaultKeyWithPassword(
    host.requireRawRoot(),
    input.password,
  );
  const passwordRecord: PasswordProtectorRecord = {
    kind: "password",
    protectorId: newProtectorId("password"),
    legacy: true,
    kdf: {
      alg: "PBKDF2-SHA256",
      saltB64: wrapped.kdf.saltB64,
      iterations: wrapped.kdf.iterations,
    },
    wrap: wrapped.wrap,
    proofStatus: "verified",
  };
  const nextManifest: Omit<RootProtectionManifest, "authB64"> = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    vaultId: base.vaultId,
    rootKeyId: newOpaqueId("root"),
    rootEpoch: base.rootEpoch + 1,
    revision: base.revision + 1,
    purpose: base.purpose,
    records: [passwordRecord],
  };
  const sealed = await sealAuthenticatedManifest(
    host.requireRawRoot(),
    nextManifest,
  );
  await host.persistHeader({
    ...header,
    kdf: wrapped.kdf,
    wrap: wrapped.wrap,
    unlocks: undefined,
    protection: sealed,
  });
}
