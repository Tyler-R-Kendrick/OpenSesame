/** Owner-selected, exact retired-password detectors; never production authority. */
import { bytesToB64 } from "@opensesame/vault-core";
import { queueRetiredCredentialObservation } from "../credential-observation/hooks.js";
import {
  assertAuthenticationSession,
  assertNotDecoySession,
} from "../decoy-session.js";
import { kvDurability, kvSetDurable } from "../kv.js";
import { TOMBS_REGISTRY_KEY, listTombs } from "../vfs.js";

import {
  MAX_RETIRED_CREDENTIAL_EVENTS as MAX_EVENTS,
  type RetiredCredentialTrap,
  type RetiredDecoyAction,
  responseSchema,
  retiredDecoyActionSchema,
} from "./records.js";
export { MAX_RETIRED_CREDENTIAL_TRAPS } from "./records.js";
export type {
  RetiredCredentialResponse,
  RetiredCredentialTrap,
  RetiredCredentialEvent,
} from "./records.js";
export {
  retiredCredentialOwnerSeams,
  retiredCredentialEnrollmentSupported,
} from "./owner-policy.js";
import { exclusive, retiredCredentialStorageSeams } from "./credential-lock.js";
import type {
  ClearRetiredCredentialEventsInput,
  EnrollRetiredCredentialInput,
  RemoveRetiredCredentialInput,
} from "./management-inputs.js";
import { key, matches, read } from "./record-access.js";
import { trackRetiredCredentialTelemetry } from "./telemetry-queue.js";
export { flushRetiredCredentialTelemetry } from "./telemetry-queue.js";
export { retiredCredentialStorageSeams } from "./credential-lock.js";
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
export async function enrollRetiredCredential(
  input: EnrollRetiredCredentialInput,
): Promise<void> {
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
  const authorityGeneration = assertNotDecoySession();
  return exclusive(async () => {
    assertNotDecoySession(authorityGeneration);
    const operation = await import("./owner-operations.js");
    assertNotDecoySession(authorityGeneration);
    return operation.enrollAuthenticatedRetiredCredential(
      input,
      response,
      authorityGeneration,
    );
  });
}
export async function removeRetiredCredential(
  input: RemoveRetiredCredentialInput,
): Promise<void> {
  const authorityGeneration = assertNotDecoySession();
  return exclusive(async () => {
    assertNotDecoySession(authorityGeneration);
    const operation = await import("./owner-operations.js");
    assertNotDecoySession(authorityGeneration);
    return operation.removeAuthenticatedRetiredCredential(
      input,
      authorityGeneration,
    );
  });
}
export async function clearRetiredCredentialEvents(
  input: ClearRetiredCredentialEventsInput,
): Promise<void> {
  const authorityGeneration = assertNotDecoySession();
  return exclusive(async () => {
    assertNotDecoySession(authorityGeneration);
    const operation = await import("./owner-operations.js");
    assertNotDecoySession(authorityGeneration);
    return operation.clearAuthenticatedRetiredCredentialEvents(
      input,
      authorityGeneration,
    );
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
