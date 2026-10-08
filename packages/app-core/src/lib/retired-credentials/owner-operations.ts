/** Fresh owner operations load only for explicit authentication or management. */
import {
  type VaultHeader,
  WrongPasswordError,
  bytesToB64,
  unwrapRawVaultKeyFromPassword,
} from "@opensesame/vault-core";
import {
  assertAuthenticationSession,
  assertNotDecoySession,
  freshOwnerAuthenticationTomb,
  freshOwnerAuthenticationVault,
  requiresFreshOwnerAuthentication,
} from "../decoy-session.js";
import {
  ENROLLMENT_STATE_KEY,
  journalKeysOf,
} from "../duress/store/boot-keys.js";
import { loadEnrollmentStateForUnlock } from "../duress/store/unlock-enrollment.js";
import { fingerprintCode } from "../duress/trigger/codes.js";
import {
  disposeTriggerMatch,
  selectTrigger,
} from "../duress/trigger/enrollment-select.js";
import { kvRefresh, kvSetDurable } from "../kv.js";
import { verifyManifestAuth } from "../vault/protection/manifest-auth.js";
import {
  authenticationHeaderWitness,
  validateAuthenticationHeader,
} from "../vault/store-auth-header.js";
import { readTombHeader } from "../vault/store-header.js";
import { vaultIdentity } from "../vault/store-vault-identity.js";
import { withBodyWriteLock } from "../vault/vault-shared-locks.js";
import { HEADER_PATH, tombFileKey } from "../vfs.js";
import { retiredCredentialStorageSeams } from "./credential-lock.js";
import type {
  ClearRetiredCredentialEventsInput,
  EnrollRetiredCredentialInput,
  RemoveRetiredCredentialInput,
} from "./management-inputs.js";
import {
  authoritativeHeader,
  retiredCredentialOwnerSeams,
} from "./owner-policy.js";
import { key, matches, read, verifier } from "./record-access.js";
import {
  MAX_RETIRED_CREDENTIAL_TRAPS,
  type Records,
  type RetiredCredentialResponse,
} from "./records.js";
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
  const authorityGeneration = assertAuthenticationSession();
  const check = () => {
    assertAuthenticationSession(authorityGeneration);
  };
  const witness = await verifiedHeaderWitness(tomb, password, refresh, check);
  await validateAuthenticationHeader(tomb, witness, check);
  checkAuthenticationIdentity(tomb, readTombHeader(tomb));
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
  const witness = await verifiedHeaderWitness(tomb, password, refresh, () => {
    assertNotDecoySession(authorityGeneration);
  });
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
  check: () => void,
): Promise<string> {
  await refresh(tombFileKey(tomb, HEADER_PATH), 65536);
  check();
  const stored = readTombHeader(tomb);
  if (!stored)
    throw new Error("A sealed vault with a current password is required.");
  checkAuthenticationIdentity(tomb, stored);
  const witness = authenticationHeaderWitness(stored);
  const header = authoritativeHeader(stored);
  const raw = await unwrapRawVaultKeyFromPassword(header, password);
  try {
    if (header.protection) await verifyManifestAuth(raw, header.protection);
    check();
    checkAuthenticationIdentity(tomb, stored);
    return witness;
  } finally {
    raw.fill(0);
  }
}

function checkAuthenticationIdentity(
  tomb: string,
  header: VaultHeader | null,
): void {
  if (
    requiresFreshOwnerAuthentication() &&
    (freshOwnerAuthenticationTomb() !== tomb ||
      freshOwnerAuthenticationVault() !== vaultIdentity(header))
  ) {
    throw new Error(
      "Authenticate the original vault before using member capabilities.",
    );
  }
}

export function persistAuthenticatedRecords(
  input: { tomb: string; currentPassword: string },
  records: Records,
  generation: number,
): Promise<void> {
  const { tomb, currentPassword } = input;
  return withAuthenticatedRetiredCredentialOwner(
    tomb,
    currentPassword,
    async () => {
      assertNotDecoySession(generation);
      await kvSetDurable(
        tombFileKey(tomb, "retired-credentials.v1"),
        JSON.stringify(records),
      );
      assertNotDecoySession(generation);
    },
    retiredCredentialStorageSeams.refresh,
  );
}

function authenticate(tomb: string, password: string): Promise<void> {
  return authenticateRetiredCredentialOwner(
    tomb,
    password,
    retiredCredentialStorageSeams.refresh,
  );
}

export async function enrollAuthenticatedRetiredCredential(
  input: EnrollRetiredCredentialInput,
  response: RetiredCredentialResponse,
  authorityGeneration: number,
): Promise<void> {
  await authenticate(input.tomb, input.currentPassword);
  const { LEGACY_CONNECTOR_SECRET_KEY, hasUnresolvedLegacyConnectorSecrets } =
    await import("../device-connector-legacy-storage.js");
  await retiredCredentialStorageSeams.refresh(
    LEGACY_CONNECTOR_SECRET_KEY,
    262144,
  );
  if (hasUnresolvedLegacyConnectorSecrets())
    throw new Error(
      "Resolve legacy connector credentials in Security settings before enrolling retired-password traps.",
    );
  await retiredCredentialStorageSeams.refresh(key(input.tomb), 32768);
  const r = read(input.tomb);
  if (r.traps.length >= MAX_RETIRED_CREDENTIAL_TRAPS)
    throw new Error("Remove a trap before enrolling another (maximum 3).");
  // Vault passwords normalize NFKC; reject any spelling that can still unwrap it.
  let current = false;
  try {
    await authenticate(input.tomb, input.retiredPassword);
    current = true;
  } catch (error) {
    if (!(error instanceof WrongPasswordError)) throw error;
  }
  if (current || (await matches(input.retiredPassword, r.traps)))
    throw new Error(
      "This password collides with a current password or existing trap.",
    );
  for (const stateKey of journalKeysOf(ENROLLMENT_STATE_KEY))
    await retiredCredentialStorageSeams.refresh(stateKey, 131072);
  const state = loadEnrollmentStateForUnlock();
  if (state) {
    if (state.triggers.some((t) => t.triggerKind === "prf_and_code"))
      throw new Error(
        "Retired password enrollment cannot verify collisions with a two-secret duress code.",
      );
    const digest = await fingerprintCode(input.retiredPassword);
    const match = await selectTrigger(input.retiredPassword, state);
    const collision =
      match.status !== "none" ||
      state.ordinaryCodeFingerprints.includes(digest);
    disposeTriggerMatch(match);
    if (collision)
      throw new Error(
        "This password collides with an enrolled unlock or duress code.",
      );
  }
  const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
  r.traps.push({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    response,
    salt,
    verifier: await verifier(input.retiredPassword, salt),
  });
  await persistAuthenticatedRecords(input, r, authorityGeneration);
}

export async function removeAuthenticatedRetiredCredential(
  input: RemoveRetiredCredentialInput,
  authorityGeneration: number,
): Promise<void> {
  await authenticate(input.tomb, input.currentPassword);
  await retiredCredentialStorageSeams.refresh(key(input.tomb), 32768);
  const r = read(input.tomb);
  r.traps = r.traps.filter((t) => t.id !== input.id);
  await persistAuthenticatedRecords(input, r, authorityGeneration);
}

export async function clearAuthenticatedRetiredCredentialEvents(
  input: ClearRetiredCredentialEventsInput,
  authorityGeneration: number,
): Promise<void> {
  await authenticate(input.tomb, input.currentPassword);
  await retiredCredentialStorageSeams.refresh(key(input.tomb), 32768);
  const r = read(input.tomb);
  r.events = [];
  await persistAuthenticatedRecords(input, r, authorityGeneration);
}
