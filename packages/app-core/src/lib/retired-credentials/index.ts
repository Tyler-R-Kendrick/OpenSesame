/** Owner-selected, exact retired-password detectors; never production authority. */
import {
  WrongPasswordError,
  b64ToBytes,
  bytesToB64,
} from "@opensesame/vault-core";
import { queueRetiredCredentialObservation } from "../credential-observation/hooks.js";
import {
  assertAuthenticationSession,
  assertNotDecoySession,
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
import { kvDurability, kvGet, kvSetDurable } from "../kv.js";
import { TOMBS_REGISTRY_KEY, listTombs, tombFileKey } from "../vfs.js";

import {
  MAX_RETIRED_CREDENTIAL_EVENTS as MAX_EVENTS,
  MAX_RETIRED_CREDENTIAL_TRAPS,
  type Records,
  type RetiredCredentialResponse,
  type RetiredCredentialTrap,
  type RetiredDecoyAction,
  type TrapRecord,
  parseRetiredCredentialRecords,
  responseSchema,
  retiredDecoyActionSchema,
} from "./records.js";
export { MAX_RETIRED_CREDENTIAL_TRAPS } from "./records.js";
export type {
  RetiredCredentialResponse,
  RetiredCredentialTrap,
  RetiredCredentialEvent,
} from "./records.js";
import { authenticateRetiredCredentialOwner } from "./owner-auth.js";
import { persistAuthenticatedRecords } from "./owner-records.js";
export {
  retiredCredentialOwnerSeams,
  retiredCredentialEnrollmentSupported,
} from "./owner-auth.js";
import { exclusive, retiredCredentialStorageSeams } from "./credential-lock.js";
import { trackRetiredCredentialTelemetry } from "./telemetry-queue.js";
export { flushRetiredCredentialTelemetry } from "./telemetry-queue.js";
export { retiredCredentialStorageSeams } from "./credential-lock.js";
function key(tomb: string): string {
  return tombFileKey(tomb, "retired-credentials.v1");
}
function read(tomb: string): Records {
  const raw = kvGet(key(tomb));
  if (!raw) return { v: 1, tomb, traps: [], events: [] };
  return parseRetiredCredentialRecords(raw, tomb);
}
/** Fixed bounded memory-hard KDF; exact bytes, no Unicode normalization. */
async function verifier(password: string, salt: string): Promise<string> {
  const bytes = new TextEncoder().encode(password);
  try {
    const { deriveRetiredVerifier } = await import("./argon-verifier.js");
    const derived = await deriveRetiredVerifier(bytes, b64ToBytes(salt));
    try {
      return bytesToB64(derived);
    } finally {
      derived.fill(0);
    }
  } finally {
    bytes.fill(0);
  }
}
async function matches(
  password: string,
  traps: TrapRecord[],
): Promise<TrapRecord | null> {
  let found: TrapRecord | null = null;
  for (const t of traps)
    if ((await verifier(password, t.salt)) === t.verifier) {
      if (found) throw new Error("Ambiguous retired credential records.");
      found = t;
    }
  return found;
}
function authenticate(tomb: string, password: string): Promise<void> {
  return authenticateRetiredCredentialOwner(
    tomb,
    password,
    retiredCredentialStorageSeams.refresh,
  );
}
export function retiredCredentialStatus(tomb: string) {
  const r = read(tomb);
  return {
    traps: r.traps.map(({ id, createdAt, response }) => ({
      id,
      createdAt,
      response,
    })),
    events: r.events.map((e) => ({ ...e })),
    durable: kvDurability() === "persistent",
  };
}
export async function enrollRetiredCredential(input: {
  tomb: string;
  currentPassword: string;
  retiredPassword: string;
  response?: RetiredCredentialResponse;
  acknowledgePasswordVerifierRisk: boolean;
}): Promise<void> {
  if (input.acknowledgePasswordVerifierRisk !== true)
    throw new Error(
      "Acknowledge the password verifier exposure before enrollment.",
    );
  const response = input.response ?? "reject";
  if (input.retiredPassword !== input.retiredPassword.normalize("NFKC"))
    throw new Error(
      "Retired credentials must use their exact normalized vault-password spelling.",
    );
  if (
    !responseSchema.safeParse(response).success ||
    !input.retiredPassword ||
    input.retiredPassword.length > 1024
  )
    throw new Error("Choose a valid retired password and response.");
  return exclusive(async () => {
    const authorityGeneration = assertNotDecoySession();
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
  });
}
export async function removeRetiredCredential(input: {
  tomb: string;
  currentPassword: string;
  id: string;
}): Promise<void> {
  return exclusive(async () => {
    const authorityGeneration = assertNotDecoySession();
    await authenticate(input.tomb, input.currentPassword);
    await retiredCredentialStorageSeams.refresh(key(input.tomb), 32768);
    const r = read(input.tomb);
    r.traps = r.traps.filter((t) => t.id !== input.id);
    await persistAuthenticatedRecords(input, r, authorityGeneration);
  });
}
export async function clearRetiredCredentialEvents(input: {
  tomb: string;
  currentPassword: string;
}): Promise<void> {
  return exclusive(async () => {
    const authorityGeneration = assertNotDecoySession();
    await authenticate(input.tomb, input.currentPassword);
    await retiredCredentialStorageSeams.refresh(key(input.tomb), 32768);
    const r = read(input.tomb);
    r.events = [];
    await persistAuthenticatedRecords(input, r, authorityGeneration);
  });
}
/** Match and record before duress selection or production unwrap; corrupt state refuses. */
export async function probeRetiredCredential(
  password: string,
  tomb: string,
): Promise<RetiredCredentialTrap | null> {
  const generation = assertAuthenticationSession();
  if (!retiredCredentialStorageSeams.locks() && !read(tomb).traps.length)
    return null;
  return exclusive(async () => {
    await retiredCredentialStorageSeams.refresh(key(tomb), 32768);
    assertAuthenticationSession(generation);
    const r = read(tomb);
    if (!r.traps.length) return null;
    if (password.length > 1024) throw new Error("Credential is too long.");
    const t = await matches(password, r.traps);
    assertAuthenticationSession(generation);
    if (!t) return null;
    const event = {
      type: "retired_credential_observed" as const,
      trapId: t.id,
      at: new Date().toISOString(),
      response: t.response,
    };
    r.events = [...r.events, event].slice(-MAX_EVENTS);
    assertAuthenticationSession(generation);
    await kvSetDurable(key(tomb), JSON.stringify(r));
    assertAuthenticationSession(generation);
    await queueRetiredCredentialObservation(tomb, event);
    assertAuthenticationSession(generation);
    return { id: t.id, createdAt: t.createdAt, response: t.response };
  });
}

/** Reject credential reuse without recording an observation or opening a realm. */
export async function assertNotRetiredCredential(
  password: string,
  tomb: string,
): Promise<void> {
  if (!retiredCredentialStorageSeams.locks() && !read(tomb).traps.length)
    return;
  return exclusive(async () => {
    await retiredCredentialStorageSeams.refresh(key(tomb), 32768);
    if (await matches(password.normalize("NFKC"), read(tomb).traps))
      throw new Error(
        "Remove the retired credential trap before reusing this password.",
      );
  });
}

/** Global duress codes may never share a selected retired password in any tomb. */
export async function assertNotRetiredCredentialAcrossVaults(
  password: string,
): Promise<void> {
  if (
    !retiredCredentialStorageSeams.locks() &&
    listTombs().every((tomb) => !read(tomb).traps.length)
  )
    return;
  return exclusive(async () => {
    for (const tomb of listTombs()) {
      await retiredCredentialStorageSeams.refresh(key(tomb), 32768);
      if (await matches(password.normalize("NFKC"), read(tomb).traps))
        throw new Error(
          "Remove the retired credential trap before using this duress code.",
        );
    }
  });
}

/** Hold the same cross-tab lock through collision evaluation and the header commit. */
export async function withRetiredCredentialChange<T>(
  password: string,
  tomb: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!retiredCredentialStorageSeams.locks() && !read(tomb).traps.length)
    return work();
  return exclusive(async () => {
    await retiredCredentialStorageSeams.refresh(key(tomb), 32768);
    if (await matches(password.normalize("NFKC"), read(tomb).traps))
      throw new Error(
        "Remove the retired credential trap before reusing this password.",
      );
    return work();
  });
}

/** Best-effort device-local evidence; no submitted values or attacker-controlled text. */
export function recordRetiredDecoyInteraction(
  tomb: string,
  trapId: string,
  action: RetiredDecoyAction,
): Promise<void> {
  return trackRetiredCredentialTelemetry(
    writeRetiredDecoyInteraction(tomb, trapId, action),
  );
}
async function writeRetiredDecoyInteraction(
  tomb: string,
  trapId: string,
  action: RetiredDecoyAction,
): Promise<void> {
  if (!retiredDecoyActionSchema.safeParse(action).success) return;
  try {
    await exclusive(async () => {
      await retiredCredentialStorageSeams.refresh(key(tomb), 32768);
      const r = read(tomb);
      if (
        !r.traps.some(
          (t) => t.id === trapId && t.response === "synthetic_decoy",
        )
      )
        return;
      const event = {
        type: "synthetic_decoy_interaction" as const,
        trapId,
        at: new Date().toISOString(),
        response: "synthetic_decoy" as const,
        action,
      };
      r.events = [...r.events, event].slice(-MAX_EVENTS);
      await kvSetDurable(key(tomb), JSON.stringify(r));
      await queueRetiredCredentialObservation(tomb, event);
    });
  } catch {
    /* Local telemetry cannot create authority or disable a session. */
  }
}

/** Refresh local evidence for an owner tab that was already open during replay. */
export async function refreshRetiredCredentialStatus(tomb: string) {
  if (!retiredCredentialStorageSeams.locks() && !read(tomb).traps.length)
    return retiredCredentialStatus(tomb);
  return exclusive(async () => {
    await retiredCredentialStorageSeams.refresh(key(tomb), 32768);
    return retiredCredentialStatus(tomb);
  });
}

async function trapSetFingerprint(): Promise<string> {
  await retiredCredentialStorageSeams.refresh(TOMBS_REGISTRY_KEY, 32768);
  const set = [];
  for (const tomb of listTombs().sort()) {
    await retiredCredentialStorageSeams.refresh(key(tomb), 32768);
    set.push({ tomb, traps: read(tomb).traps });
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(set)),
  );
  return bytesToB64(new Uint8Array(digest));
}
function credentialCeremony<T>(work: () => Promise<T>): Promise<T> {
  if (
    !retiredCredentialStorageSeams.locks() &&
    listTombs().every((tomb) => !read(tomb).traps.length)
  )
    return work();
  return exclusive(work);
}
/** Seal a duress draft and bind it to the selected trap set without retaining a code. */
export async function withRetiredCredentialDuressSeal<T>(
  code: string,
  work: () => Promise<T>,
) {
  return credentialCeremony(async () => {
    const fingerprint = await trapSetFingerprint();
    for (const tomb of listTombs())
      if (await matches(code, read(tomb).traps))
        throw new Error("Retired credential collides with this duress code.");
    return { value: await work(), fingerprint };
  });
}
/** Arm only if no trap was enrolled/removed/changed since the draft was sealed. */
export async function withRetiredCredentialDuressArm<T>(
  fingerprint: string,
  work: () => Promise<T>,
): Promise<T> {
  return credentialCeremony(async () => {
    if (fingerprint !== (await trapSetFingerprint()))
      throw new Error(
        "Retired credential enrollment changed. Seal this duress code again.",
      );
    return work();
  });
}
