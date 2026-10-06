/** Fresh owner verification uses the authoritative protector, never an obsolete wrap. */
import {
  type RootProtectionManifest,
  type VaultHeader,
  unwrapRawVaultKeyFromPassword,
} from "@opensesame/vault-core";
import { assertNotDecoySession } from "../decoy-session.js";
import { kvRefresh } from "../kv.js";
import { verifyManifestAuth } from "../vault/protection/manifest-auth.js";
import { parseRootProtectionManifest } from "../vault/protection/parse.js";
import {
  authenticationHeaderWitness,
  validateAuthenticationHeader,
} from "../vault/store-auth-header.js";
import { readTombHeader } from "../vault/store-header.js";
import { withBodyWriteLock } from "../vault/vault-shared-locks.js";
import { HEADER_PATH, tombFileKey } from "../vfs.js";
export const retiredCredentialOwnerSeams = {
  isRealOwner: (_tomb: string): boolean => false,
};

function headerRequiresMfa(header: VaultHeader): boolean {
  return Boolean(
    header.unlocks?.totp || header.unlocks?.email || header.unlocks?.sms,
  );
}
function manifestRequiresMfa(manifest: RootProtectionManifest): boolean {
  const gates = manifest.legacyGates;
  return Boolean(
    gates?.totpEnrolled ||
      gates?.emailEnrolled ||
      gates?.smsEnrolled ||
      manifest.purpose !== "human-vault-root",
  );
}
function authoritativeHeader(header: VaultHeader): VaultHeader {
  if (headerRequiresMfa(header))
    throw new Error(
      "Retired credential management requires a fresh multi-factor ceremony for this vault.",
    );
  if (!header.protection) {
    if (!header.kdf || !header.wrap)
      throw new Error("A current password protector is required.");
    return header;
  }
  const manifest = parseRootProtectionManifest(
    JSON.stringify(header.protection),
  );
  if (manifestRequiresMfa(manifest))
    throw new Error(
      "Retired credential management requires a fresh multi-factor ceremony for this vault.",
    );
  if (
    manifest.records.length !== 1 ||
    manifest.records[0]?.kind !== "password" ||
    manifest.records[0].proofStatus !== "verified"
  )
    throw new Error(
      "Retired credential management currently requires one verified password protector.",
    );
  const record = manifest.records[0];
  return {
    ...header,
    kdf: record.kdf,
    wrap: record.wrap,
    protection: manifest,
  };
}
export function retiredCredentialEnrollmentSupported(tomb: string): boolean {
  const header = readTombHeader(tomb);
  if (!header) return false;
  try {
    authoritativeHeader(header);
    return true;
  } catch {
    return false;
  }
}
export async function authenticateRetiredCredentialOwner(
  tomb: string,
  password: string,
  refresh = kvRefresh,
): Promise<void> {
  const authorityGeneration = assertNotDecoySession();
  if (!retiredCredentialOwnerSeams.isRealOwner(tomb))
    throw new Error(
      "Unlock the real vault before managing retired credentials.",
    );
  await verifyCurrentCredential(tomb, password, refresh);
  assertNotDecoySession(authorityGeneration);
  if (!retiredCredentialOwnerSeams.isRealOwner(tomb))
    throw new Error("The owner session changed during authentication.");
}
/** Password admission proof only. This confers no owner-management permission. */
export async function verifyCurrentCredential(
  tomb: string,
  password: string,
  refresh = kvRefresh,
): Promise<void> {
  const authorityGeneration = assertNotDecoySession();
  const witness = await verifiedHeaderWitness(
    tomb,
    password,
    refresh,
    authorityGeneration,
  );
  await validateAuthenticationHeader(tomb, witness, () => {
    assertNotDecoySession(authorityGeneration);
  });
}

/** The policy proof and its bounded settings commit share the policy writer's lock. */
export async function withAuthenticatedRetiredCredentialOwner(
  tomb: string,
  password: string,
  commit: () => Promise<void>,
  refresh = kvRefresh,
): Promise<void> {
  const authorityGeneration = assertNotDecoySession();
  const check = () => {
    assertNotDecoySession(authorityGeneration);
    if (!retiredCredentialOwnerSeams.isRealOwner(tomb))
      throw new Error("The owner session changed during authentication.");
  };
  check();
  const witness = await verifiedHeaderWitness(
    tomb,
    password,
    refresh,
    authorityGeneration,
  );
  await withBodyWriteLock(tomb, async () => {
    check();
    if (authenticationHeaderWitness(readTombHeader(tomb)) !== witness)
      throw new Error(
        "Vault authentication changed before the settings commit.",
      );
    await commit();
    check();
  });
}

async function verifiedHeaderWitness(
  tomb: string,
  password: string,
  refresh: typeof kvRefresh,
  authorityGeneration: number,
): Promise<string> {
  await refresh(tombFileKey(tomb, HEADER_PATH), 65536);
  assertNotDecoySession(authorityGeneration);
  const stored = readTombHeader(tomb);
  if (!stored)
    throw new Error("A sealed vault with a current password is required.");
  const witness = authenticationHeaderWitness(stored);
  const header = authoritativeHeader(stored);
  const raw = await unwrapRawVaultKeyFromPassword(header, password);
  try {
    if (header.protection) await verifyManifestAuth(raw, header.protection);
    assertNotDecoySession(authorityGeneration);
    return witness;
  } finally {
    raw.fill(0);
  }
}
