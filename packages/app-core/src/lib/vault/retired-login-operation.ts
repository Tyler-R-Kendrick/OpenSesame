/** Physical, context-bound login data. Only the private Store may select a realm. */
import { b64ToBytes } from "@opensesame/vault-core";
import { verifyRetiredPassword } from "../retired-credentials/argon-verifier.js";
import {
  deriveRetiredCredentialContextV2,
  encodeRetiredCredentialContextV2,
} from "../retired-credentials/context-v2.js";
import {
  MAX_RETIRED_EVENTS_V2,
  type TrapRecordV2,
  encodeRetiredCredentialRecordsV2,
  parseRetainedRetiredCredentialRecordsV2,
} from "../retired-credentials/records-v2.js";
import { isRetiredTrapLive } from "../retired-credentials/retention-v2.js";
import {
  captureRetiredOwnerResources,
  withRetiredOwnerReaders,
} from "./retired-owner-resources.js";

export type RetiredLoginData = Readonly<{
  tomb: string;
  context: string;
  trap: Readonly<TrapRecordV2>;
}>;

async function matchingLiveTrap(
  password: string,
  traps: readonly TrapRecordV2[],
  check: () => void,
) {
  let matched: TrapRecordV2 | undefined;
  for (const trap of traps) {
    if (!isRetiredTrapLive(trap.createdAt, trap.expiresAt, Date.now()))
      continue;
    const salt = b64ToBytes(trap.salt);
    const verifier = b64ToBytes(trap.verifier);
    try {
      const match = await verifyRetiredPassword(password, salt, verifier);
      check();
      if (!match) continue;
      if (matched) throw new Error("Ambiguous retired credential records.");
      matched = trap;
    } finally {
      salt.fill(0);
      verifier.fill(0);
    }
  }
  return matched;
}

/** No primary unwrap, real root or owner membership is produced by this operation. */
export async function readRetiredLoginData(
  tomb: string,
  password: string,
  original: () => void,
  consume?: (data: RetiredLoginData) => Promise<void>,
): Promise<RetiredLoginData | null> {
  const resources = captureRetiredOwnerResources(tomb, original);
  return await resources.withLeases(() =>
    withRetiredOwnerReaders(resources, tomb, async (readers) => {
      const snapshot = await readers.auth.read();
      const key = `tomb/${tomb}/retired-credentials.v2`;
      const raw = await readers.device.read(key, 32768);
      resources.check();
      if (raw === null) return null;
      const records = parseRetainedRetiredCredentialRecordsV2(raw);
      if (!snapshot.header || !snapshot.body)
        throw new Error("Original vault is incomplete.");
      const context = encodeRetiredCredentialContextV2(
        await deriveRetiredCredentialContextV2(tomb, snapshot.header),
      );
      resources.check();
      // Retained stale hashes remain available for collision prevention, never realm selection.
      if (encodeRetiredCredentialContextV2(records.context) !== context)
        return null;
      const trap = await matchingLiveTrap(
        password,
        records.traps,
        resources.check,
      );
      if (!trap) return null;
      const current = await readers.auth.read();
      if (current.header !== snapshot.header || current.body !== snapshot.body)
        throw new Error(
          "Original vault changed during credential recognition.",
        );
      resources.check();
      if (!isRetiredTrapLive(trap.createdAt, trap.expiresAt, Date.now()))
        return null;
      records.events.push({
        type: "retired_credential_observed",
        trapId: trap.id,
        at: new Date().toISOString(),
        response: trap.response,
      });
      records.events = records.events.slice(-MAX_RETIRED_EVENTS_V2);
      const next = encodeRetiredCredentialRecordsV2(
        JSON.stringify(records),
        context,
      );
      await readers.device.publish(key, raw, next, 32768, resources.check);
      resources.check();
      const final = await readers.auth.read();
      if (
        final.header !== snapshot.header ||
        final.body !== snapshot.body ||
        (await readers.device.read(key, 32768)) !== next
      )
        throw new Error("Original retired credential publication changed.");
      resources.check();
      const observed = Object.freeze({
        tomb,
        context,
        trap: Object.freeze({ ...trap }),
      });
      if (consume) await consume(observed);
      resources.check();
      return observed;
    }),
  );
}

/** Records synthetic interactions without admitting an owner or retaining their root. */
export async function appendRetiredInteraction(
  data: RetiredLoginData,
  action: "vault_read" | "vault_export" | "vault_write" | "authority_denied",
  original: () => void,
): Promise<void> {
  const resources = captureRetiredOwnerResources(data.tomb, original);
  await resources.withLeases(() =>
    withRetiredOwnerReaders(resources, data.tomb, async (readers) => {
      const snapshot = await readers.auth.read();
      if (!snapshot.header || !snapshot.body)
        throw new Error("Original vault is unavailable.");
      const context = encodeRetiredCredentialContextV2(
        await deriveRetiredCredentialContextV2(data.tomb, snapshot.header),
      );
      if (context !== data.context)
        throw new Error("Synthetic origin changed.");
      const key = `tomb/${data.tomb}/retired-credentials.v2`;
      const raw = await readers.device.read(key, 32768);
      if (raw === null) throw new Error("Retired record was removed.");
      const records = parseRetainedRetiredCredentialRecordsV2(raw);
      if (
        encodeRetiredCredentialContextV2(records.context) !== context ||
        !records.traps.some(
          (trap) =>
            trap.id === data.trap.id &&
            trap.salt === data.trap.salt &&
            trap.verifier === data.trap.verifier &&
            trap.createdAt === data.trap.createdAt &&
            trap.expiresAt === data.trap.expiresAt &&
            trap.response === "synthetic_decoy" &&
            data.trap.response === "synthetic_decoy" &&
            isRetiredTrapLive(trap.createdAt, trap.expiresAt, Date.now()),
        )
      )
        throw new Error("Retired record changed.");
      records.events.push({
        type: "synthetic_decoy_interaction",
        trapId: data.trap.id,
        at: new Date().toISOString(),
        response: "synthetic_decoy",
        action,
      });
      records.events = records.events.slice(-MAX_RETIRED_EVENTS_V2);
      const next = encodeRetiredCredentialRecordsV2(
        JSON.stringify(records),
        context,
      );
      const current = await readers.auth.read();
      if (current.header !== snapshot.header || current.body !== snapshot.body)
        throw new Error("Synthetic origin changed during interaction.");
      resources.check();
      await readers.device.publish(key, raw, next, 32768, resources.check);
      resources.check();
      if ((await readers.device.read(key, 32768)) !== next)
        throw new Error("Synthetic interaction publication changed.");
      resources.check();
    }),
  );
}
