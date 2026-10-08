/** Independent per-tomb device-at-rest records; no vault-root or incident capability. */
import { z } from "zod";
import { lockManager } from "../../ports.js";
import { currentCredentialObservationIdentity } from "../credential-canaries/owner.js";
import { kvGet, kvRefresh, kvSetDurable } from "../kv.js";
import { HEADER_PATH, tombFileKey } from "../vfs.js";
import { isoSchema, packageSchema, provisionSchema } from "./protocol.js";
export const MAX_OUTBOX_BYTES = 65536;
export const MAX_OUTBOX_ENTRIES = 32;
export const MAX_ATTEMPTS = 5;
export const receiverConfigSchema = z
  .object({
    v: z.literal(1),
    tomb: z.string().min(1).max(256),
    vaultIdentity: z.string().min(1).max(256),
    revision: z.string().uuid(),
    provision: provisionSchema,
    enabled: z.boolean(),
    verified: z.boolean(),
  })
  .strict();
export type ReceiverConfig = z.infer<typeof receiverConfigSchema>;
const entrySchema = z
  .object({
    revision: z.string().uuid(),
    package: packageSchema,
    testing: z.boolean(),
    attempts: z.number().int().min(0).max(MAX_ATTEMPTS),
    lastAttemptAt: isoSchema.nullable(),
  })
  .strict();
const outboxSchema = z
  .object({
    v: z.literal(1),
    tomb: z.string().min(1).max(256),
    vaultIdentity: z.string().min(1).max(256),
    entries: z.array(entrySchema).max(MAX_OUTBOX_ENTRIES),
    history: z
      .array(
        z
          .object({
            fingerprint: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
            at: isoSchema,
          })
          .strict(),
      )
      .max(8),
    failed: z.number().int().min(0).max(4294967295),
  })
  .strict();
export type ObservationOutbox = z.infer<typeof outboxSchema>;
export type ObservationOutboxEntry = z.infer<typeof entrySchema>;
export function receiverKey(tomb: string): string {
  return tombFileKey(tomb, "credential-observation-receiver.v1");
}
export function outboxKey(tomb: string): string {
  return tombFileKey(tomb, "credential-observation-outbox.v1");
}
export async function withObservationLock<T>(
  tomb: string,
  work: () => Promise<T>,
): Promise<T> {
  const locks = lockManager();
  if (!locks) throw new Error("Cross-tab observation locking is required.");
  receiverKey(tomb);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tomb)),
  );
  const name = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return locks.request(
    `opensesame.credential-observations.${name}`,
    { mode: "exclusive" },
    () => work(),
  );
}
export async function readReceiverConfig(
  tomb: string,
  check: () => void = () => {},
): Promise<ReceiverConfig | null> {
  check();
  await kvRefresh(receiverKey(tomb), 8192);
  check();
  const raw = kvGet(receiverKey(tomb));
  if (raw === null) return null;
  await kvRefresh(tombFileKey(tomb, HEADER_PATH), 1048576);
  check();
  const identity = currentCredentialObservationIdentity(tomb);
  const config = receiverConfigSchema.parse(JSON.parse(raw));
  if (
    config.tomb !== tomb ||
    config.vaultIdentity !== identity ||
    (config.enabled && !config.verified)
  )
    throw new Error("Observation receiver context is unavailable.");
  return config;
}
export async function writeReceiverConfig(
  config: ReceiverConfig,
  check: () => void,
): Promise<void> {
  const value = receiverConfigSchema.parse(config);
  check();
  await kvSetDurable(receiverKey(value.tomb), JSON.stringify(value));
  check();
}
export async function readObservationOutbox(
  tomb: string,
  identity: string,
  check: () => void = () => {},
): Promise<ObservationOutbox> {
  check();
  await kvRefresh(outboxKey(tomb), MAX_OUTBOX_BYTES);
  check();
  const raw = kvGet(outboxKey(tomb));
  if (raw === null)
    return {
      v: 1,
      tomb,
      vaultIdentity: identity,
      entries: [],
      history: [],
      failed: 0,
    };
  if (new TextEncoder().encode(raw).length > MAX_OUTBOX_BYTES)
    throw new Error("Observation outbox is too large.");
  const records = outboxSchema.parse(JSON.parse(raw));
  if (
    records.tomb !== tomb ||
    records.vaultIdentity !== identity ||
    new Set(records.entries.map((e) => e.package.packageId)).size !==
      records.entries.length
  )
    throw new Error("Observation outbox context is unavailable.");
  return records;
}
export async function writeObservationOutbox(
  records: ObservationOutbox,
  check: () => void = () => {},
): Promise<void> {
  outboxSchema.parse(records);
  const raw = JSON.stringify(records);
  if (new TextEncoder().encode(raw).length > MAX_OUTBOX_BYTES)
    throw new Error("Observation outbox is too large.");
  check();
  await kvSetDurable(outboxKey(records.tomb), raw);
  check();
}
export function discardExpiredEntries(
  records: ObservationOutbox,
  config: ReceiverConfig,
  now: number,
): void {
  const kept = records.entries.filter(
    (e) =>
      e.revision === config.revision && Date.parse(e.package.expiresAt) > now,
  );
  records.failed = Math.min(
    4294967295,
    records.failed + records.entries.length - kept.length,
  );
  records.entries = kept;
  records.history = records.history.filter(
    (e) => now - Date.parse(e.at) < 3600000,
  );
}
