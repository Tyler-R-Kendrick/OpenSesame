/**
 * Manifest mutation helpers for preferred / remove / test / rotate (BROWSER).
 */

import {
  MANIFEST_SCHEMA_VERSION,
  type PasswordProtectorRecord,
  type ProtectionRecord,
  type RootProtectionManifest,
  type VaultHeader,
  mintVaultKey,
  unwrapRawVaultKeyFromPassword,
  wrapVaultKeyWithPassword,
} from "@opensesame/vault-core";
import {
  protectorIsHeaderWrap,
  protectorUnlocksVault,
} from "../unlock-preference.js";
import { assertNewPassword } from "../unlock-secret-guard.js";
import { ProtectionError } from "./errors.js";
import { newOpaqueId, newProtectorId } from "./ids.js";
import {
  assertCanRemoveProtector,
  assertExpectedRevision,
} from "./lifecycle.js";
import { sealAuthenticatedManifest } from "./manifest-auth.js";
import { migrateLegacyHeaderToManifest } from "./migrate-legacy.js";
import {
  type ProofMaterial,
  protectorCanBeTested,
  proveRecord,
} from "./protector-proof.js";

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

/**
 * Commit a sealed manifest only when the persisted manifest still sits at the
 * revision this mutation started from; a concurrent commit bumps it.
 */
async function persistSealedManifest(
  host: LifecycleHost,
  sealed: RootProtectionManifest,
  expectedRevision: number,
): Promise<void> {
  const current = host.getHeader();
  if (!current) {
    throw new ProtectionError(
      "unavailable",
      "There is no vault header on this device.",
    );
  }
  assertExpectedRevision(requireManifest(current), expectedRevision);
  await host.persistHeader({ ...current, protection: sealed });
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
  const target = base.records.find((r) => r.protectorId === protectorId);
  if (!target) {
    throw new ProtectionError(
      "malformed_encoding",
      `Protector ${protectorId} is not enrolled.`,
    );
  }
  if (!protectorUnlocksVault(target)) {
    throw new ProtectionError(
      "unavailable",
      "Only a protector that opens this vault at the unlock screen can be preferred: a password, PIN or passkey, or a verified recovery key, age key or age passkey. Test an untested one first; a cloud key cannot open a vault whose own tomb holds its credential.",
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
  await persistSealedManifest(host, sealed, base.revision);
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
  const target = base.records.find((r) => r.protectorId === protectorId);
  if (target && protectorIsHeaderWrap(target)) {
    throw new ProtectionError(
      "unavailable",
      "A password, PIN or passkey is removed under Unlock methods — removing its row here would leave the wrap that still opens the vault.",
    );
  }
  assertCanRemoveProtector(base, protectorId);
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
  await persistSealedManifest(host, sealed, base.revision);
}

/**
 * Prove a protector by opening its capsule with what the person supplies now
 * and comparing the root that comes out with this session's. Password, PIN and
 * passkey wraps are proved by unlocking with them; kinds with no browser road
 * are refused rather than re-marked verified.
 */
export async function testProtector(
  host: LifecycleHost,
  protectorId: string,
  material: ProofMaterial = {},
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
  if (!protectorCanBeTested(record.kind)) {
    throw new ProtectionError(
      "unavailable",
      record.kind === "password" ||
        record.kind === "pin" ||
        record.kind === "webauthn-prf"
        ? "Password, PIN, and passkey proofs require their unlock ceremony — open the vault with that method instead of Test."
        : `Protector kind ${record.kind} cannot be tested from a browser.`,
    );
  }
  const updated = await proveRecord({
    record,
    context: contextFor(base, record.protectorId),
    rootKey: host.requireRawRoot(),
    material,
  });
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
  await persistSealedManifest(host, sealed, base.revision);
  return updated;
}

/**
 * Mint a new vault root, re-seal the body, re-wrap with password, and reset
 * the protection manifest to the password path (root-rotate).
 *
 * The password meets the same floor as every other master-password path
 * (policy, then the duress-code collision probe) before any key changes. When
 * the vault has a master password, the one typed must be that password: a
 * rotation re-wraps it under the new root, and changing it is
 * `changeMasterPassword`'s job. With no master password enrolled there is none
 * to prove, and the password typed becomes it.
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
  if (header.wrap && header.kdf) {
    // Throws WrongPasswordError, before any key changes.
    await unwrapRawVaultKeyFromPassword(header, input.password);
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
