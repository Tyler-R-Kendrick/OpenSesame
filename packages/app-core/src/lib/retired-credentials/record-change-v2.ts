/** Bounded data transformation only; the private Store owns authentication/publication. */
import { b64ToBytes, bytesToB64 } from "@opensesame/vault-core";
import { z } from "zod";
import {
  deriveRetiredVerifier,
  passwordBytes,
  verifyRetiredPassword,
} from "./argon-verifier.js";
import { prepareClearedStaleRetiredRecords } from "./clear-stale-records-v2.js";
import { parseRetiredCredentialContextV2 } from "./context-v2.js";
import {
  MAX_RETIRED_TRAPS_V2,
  RETIRED_CREDENTIAL_MATCHING_V2,
  type RecordsV2,
  encodeRetiredCredentialRecordsV2,
  parseRetiredCredentialRecordsV2,
} from "./records-v2.js";
import {
  MAX_RETIRED_RETENTION_MS,
  isRetiredTrapLive,
  retiredTrapExpiresAt,
} from "./retention-v2.js";

const changeSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("enroll"),
    password: z.string().min(1).max(4096),
    response: z.enum(["reject", "synthetic_decoy"]),
    retentionMs: z
      .number()
      .int()
      .safe()
      .min(1)
      .max(MAX_RETIRED_RETENTION_MS)
      .optional(),
  }),
  z.strictObject({ type: z.literal("remove"), id: z.string().min(1).max(128) }),
  z.strictObject({ type: z.literal("clear-stale") }),
  z.strictObject({ type: z.literal("clear-events") }),
]);
export type RetiredRecordChange = z.infer<typeof changeSchema>;
/** Bounded primitive snapshot before asynchronous work; caller mutation must not change a collision-tested literal. */
export function readRetiredRecordChange(
  input: RetiredRecordChange,
): RetiredRecordChange {
  const value = changeSchema.parse(input);
  if (value.type === "enroll") {
    const bytes = passwordBytes(value.password);
    bytes.fill(0);
  }
  return Object.freeze(value);
}
function unavailable(): never {
  throw new Error("Retired credential change is unavailable.");
}
function decode(raw: string, length: 16 | 32): Uint8Array {
  if (raw.length !== (length === 16 ? 24 : 44)) unavailable();
  const bytes = b64ToBytes(raw);
  if (bytes.length !== length || bytesToB64(bytes) !== raw) {
    bytes.fill(0);
    unavailable();
  }
  return bytes;
}

/** A present empty, V1, malformed or differently scoped record is never initialized/rebound. */
export function readCurrentRetiredRecords(
  raw: string | null,
  contextWire: string,
): RecordsV2 {
  if (raw !== null) return parseRetiredCredentialRecordsV2(raw, contextWire);
  const context = parseRetiredCredentialContextV2(contextWire);
  return parseRetiredCredentialRecordsV2(
    JSON.stringify({
      v: 2,
      context,
      matching: RETIRED_CREDENTIAL_MATCHING_V2,
      traps: [],
      events: [],
    }),
    contextWire,
  );
}

/** Exact retired verifier only; the owning Store must separately perform genuine primary/duress collision probes. */
export async function prepareRetiredRecordChange(
  raw: string | null,
  contextWire: string,
  input: RetiredRecordChange,
  original: () => void,
): Promise<string> {
  original();
  const change = readRetiredRecordChange(input);
  // Rebuild a fresh bounded validated copy, never mutate the original authenticated slot snapshot.
  if (change.type === "clear-stale")
    return prepareClearedStaleRetiredRecords(raw, contextWire);
  const next = readCurrentRetiredRecords(raw, contextWire);
  if (change.type === "clear-events") {
    next.events = [];
  } else if (change.type === "remove") {
    if (!next.traps.some((trap) => trap.id === change.id)) unavailable();
    next.traps = next.traps.filter((trap) => trap.id !== change.id);
  } else {
    const createdAt = new Date().toISOString();
    const expiresAt = retiredTrapExpiresAt(createdAt, change.retentionMs);
    const encoded = passwordBytes(change.password);
    encoded.fill(0);
    if (next.traps.length >= MAX_RETIRED_TRAPS_V2) unavailable();
    let count = 0;
    // Owner-only ambiguity checks include every retained trap, even expired/future.
    // The separate login classifier skips out-of-window traps BEFORE KDF.
    for (const trap of next.traps) {
      const salt = decode(trap.salt, 16);
      let expected: Uint8Array | undefined;
      try {
        expected = decode(trap.verifier, 32);
        if (await verifyRetiredPassword(change.password, salt, expected))
          count++;
        original();
      } finally {
        salt.fill(0);
        expected?.fill(0);
      }
    }
    if (count) unavailable();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    try {
      const verifier = await deriveRetiredVerifier(change.password, salt);
      original();
      if (!isRetiredTrapLive(createdAt, expiresAt, Date.now())) unavailable();
      next.traps.push({
        id: crypto.randomUUID(),
        createdAt,
        expiresAt,
        response: change.response,
        salt: bytesToB64(salt),
        verifier,
      });
    } finally {
      salt.fill(0);
    }
  }
  original();
  return encodeRetiredCredentialRecordsV2(JSON.stringify(next), contextWire);
}

/** Refresh local time after every publication await; no owner authority is conveyed. */
export function assertPreparedRetiredChangeLive(
  raw: string,
  contextWire: string,
  change: RetiredRecordChange,
): void {
  if (change.type !== "enroll") return;
  const records = parseRetiredCredentialRecordsV2(raw, contextWire);
  const enrolled = records.traps.at(-1);
  if (
    !enrolled ||
    !isRetiredTrapLive(enrolled.createdAt, enrolled.expiresAt, Date.now())
  )
    unavailable();
}

/** Data preflight before any primary collision work; stale cleanup is explicit and never rebinds retained hashes. */
export function readRetiredChangeRecords(
  raw: string | null,
  wire: string,
  change: RetiredRecordChange,
): RecordsV2 {
  if (change.type === "clear-stale") {
    return parseRetiredCredentialRecordsV2(
      prepareClearedStaleRetiredRecords(raw, wire),
      wire,
    );
  }
  return readCurrentRetiredRecords(raw, wire);
}
