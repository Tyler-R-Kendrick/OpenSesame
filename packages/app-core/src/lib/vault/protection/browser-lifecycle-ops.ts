/**
 * Manifest mutation helpers for preferred / remove / test / rotate (BROWSER).
 */

import {
  type ProtectionRecord,
  type RootProtectionManifest,
  type VaultHeader,
  mintVaultKey,
  unwrapRawVaultKeyFromPassword,
  wrapVaultKeyWithPassword,
} from "@opensesame/vault-core";
import { wrapVaultKeyWithCeremony } from "../passkey-unlock-session.js";
import { operationHeader } from "../store-operation-check.js";
import {
  type VaultUnlocks,
  createPasskeyUnlockCeremony,
  withPasskeyUnlock,
  wrapVaultKeyWithPin,
} from "../unlock-methods.js";
import {
  protectorIsHeaderWrap,
  protectorUnlocksVault,
} from "../unlock-preference.js";
import { assertNewPassword, assertNewPin } from "../unlock-secret-guard.js";
import { ProtectionError } from "./errors.js";
import { newOpaqueId } from "./ids.js";
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
 * What a rotation re-wraps the new vault key under. A vault that holds a
 * master password proves it and keeps it; every other vault is re-keyed under
 * a fresh passkey (or a PIN where the browser cannot make one) and never gains
 * a password (ADR 0180).
 */
export type RotationKey =
  | { password: string }
  | { passkey: true }
  | { pin: string };

type RotationWrap = {
  kdf?: VaultHeader["kdf"];
  wrap?: VaultHeader["wrap"];
  unlocks?: VaultUnlocks;
};

/**
 * The wrap that opens `rawVaultKey` under `key`, made before any key changes:
 * a passkey ceremony can be refused, and a refusal must leave the vault as it
 * was. A password is proved against the current wrap first.
 */
async function wrapRotatedKey(
  header: VaultHeader,
  rawVaultKey: Uint8Array,
  key: RotationKey,
): Promise<RotationWrap> {
  const holdsPassword = Boolean(header.wrap && header.kdf);
  if ("password" in key) {
    if (!holdsPassword) {
      throw new ProtectionError(
        "unavailable",
        "This vault has no master password, and one is not added. Rotate with a passkey or a PIN.",
      );
    }
    await assertNewPassword(key.password);
    // Throws WrongPasswordError, before any key changes.
    await unwrapRawVaultKeyFromPassword(header, key.password);
    const wrapped = await wrapVaultKeyWithPassword(rawVaultKey, key.password);
    return { kdf: wrapped.kdf, wrap: wrapped.wrap };
  }
  if (holdsPassword) {
    throw new ProtectionError(
      "unavailable",
      "This vault holds a master password; rotate by proving it.",
    );
  }
  if ("passkey" in key) {
    const ceremony = await createPasskeyUnlockCeremony();
    const record = await wrapVaultKeyWithCeremony(rawVaultKey, ceremony);
    return { unlocks: withPasskeyUnlock(undefined, record) };
  }
  await assertNewPin(key.pin);
  return { unlocks: { pin: await wrapVaultKeyWithPin(rawVaultKey, key.pin) } };
}

/**
 * Mint a new vault root, re-seal the body, re-wrap it under one key, and reset
 * the protection manifest to what that key projects (root-rotate).
 *
 * A secret typed here meets the same floor as every other unlock secret
 * (policy, then the duress-code collision probe) before any key changes. When
 * the vault has a master password, the one typed must be that password: a
 * rotation re-wraps it under the new root, and changing it is
 * `changeMasterPassword`'s job. A vault with none is never given one: it is
 * re-keyed under a new passkey or PIN, and every other method it held is
 * dropped with the old key (the caller names which).
 */
type RootRotationHost = LifecycleHost & {
  /** Publication ordering only; this method creates no owner authority. */
  withRootWriteTurn(work: () => Promise<void>): Promise<void>;
};
export async function rotateCompromisedRoot(
  host: RootRotationHost,
  input: RotationKey,
): Promise<void> {
  const header = host.getHeader();
  if (!header) {
    throw new ProtectionError(
      "unavailable",
      "There is no vault header on this device.",
    );
  }
  const base = requireManifest(header);
  // Capture the original before asynchronous preparation; never borrow a new session.
  const previousRoot = host.requireRawRoot().slice();
  let preparedRoot: Uint8Array | undefined;
  try {
    const { rawVaultKey } = await mintVaultKey();
    preparedRoot = rawVaultKey;
    // Preparation has no persistent effects and must not hold BODY/write turns.
    const wrapped = await wrapRotatedKey(header, rawVaultKey, input);
    let restoredFailure: { error: unknown } | undefined;
    await host.withRootWriteTurn(async () => {
      try {
        await host.replaceRawVaultKey(rawVaultKey);
        const { protection: _old, ...kept } = header;
        const nextHeader: VaultHeader = {
          ...kept,
          kdf: wrapped.kdf,
          wrap: wrapped.wrap,
          unlocks: wrapped.unlocks,
        };
        const nextManifest: Omit<RootProtectionManifest, "authB64"> = {
          ...migrateLegacyHeaderToManifest({
            header: nextHeader,
            vaultId: base.vaultId,
            rootKeyId: newOpaqueId("root"),
            rootEpoch: base.rootEpoch + 1,
          }).manifest,
          revision: base.revision + 1,
          purpose: base.purpose,
        };
        const sealed = await sealAuthenticatedManifest(
          host.requireRawRoot(),
          nextManifest,
        );
        await host.persistHeader({ ...nextHeader, protection: sealed });
      } catch (error) {
        // Reverse only while the original wraps still own the header. A failed
        // effect can already have published the new header; its root must stay new.
        // An incomplete reverse stays inside the turn and closes the original
        // session. A fully completed reverse preserves the known old root.
        let restored = false;
        try {
          if (operationHeader(host.getHeader()) === operationHeader(header)) {
            await host.replaceRawVaultKey(previousRoot);
            restored = true;
          }
        } catch {
          // An indeterminate publication requires fresh authentication/recovery.
        }
        if (!restored) throw error;
        restoredFailure = { error };
      }
    });
    // The owned turn completed the actual reverse, including BODY persistence.
    // Return the original failure without retiring the restored session.
    if (restoredFailure) throw restoredFailure.error;
  } finally {
    preparedRoot?.fill(0);
    previousRoot.fill(0);
  }
}
