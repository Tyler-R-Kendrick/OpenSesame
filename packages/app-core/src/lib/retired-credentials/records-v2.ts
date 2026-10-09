/** Inactive bounded data codec. Matching context data conveys no owner authority. */
import {
  type BoundaryValue,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { z } from "zod";
import {
  encodeRetiredCredentialContextV2,
  parseRetiredCredentialContextV2,
} from "./context-v2.js";
import { assertUnambiguousJson } from "./json-preflight.js";
import { assertRetiredTrapRetention } from "./retention-v2.js";

export const MAX_RETIRED_TRAPS_V2 = 3;
export const MAX_RETIRED_EVENTS_V2 = 32;
export const MAX_RETIRED_RECORDS_V2_BYTES = 32768;
export const RETIRED_CREDENTIAL_MATCHING_V2 = Object.freeze({
  encoding: "scalar-utf8",
  normalization: "none",
  algorithm: "argon2id",
  version: 19,
  memoryKiB: 65536,
  iterations: 3,
  parallelism: 1,
  hashLength: 32,
} as const);
const matchingSchema = z.strictObject({
  encoding: z.literal(RETIRED_CREDENTIAL_MATCHING_V2.encoding),
  normalization: z.literal(RETIRED_CREDENTIAL_MATCHING_V2.normalization),
  algorithm: z.literal(RETIRED_CREDENTIAL_MATCHING_V2.algorithm),
  version: z.literal(RETIRED_CREDENTIAL_MATCHING_V2.version),
  memoryKiB: z.literal(RETIRED_CREDENTIAL_MATCHING_V2.memoryKiB),
  iterations: z.literal(RETIRED_CREDENTIAL_MATCHING_V2.iterations),
  parallelism: z.literal(RETIRED_CREDENTIAL_MATCHING_V2.parallelism),
  hashLength: z.literal(RETIRED_CREDENTIAL_MATCHING_V2.hashLength),
});
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => new TextEncoder().encode(s).length <= max);
const timestamp = z.string().max(64).datetime();
const response = z.enum(["reject", "synthetic_decoy"]);
const trap = z.strictObject({
  id: text(128),
  createdAt: timestamp,
  expiresAt: timestamp,
  response,
  salt: z.string().regex(/^[A-Za-z0-9+/]{21}[AQgw]==$/),
  verifier: z.string().regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/),
});
const retainedTrap = trap.refine((value) => {
  try {
    assertRetiredTrapRetention(value.createdAt, value.expiresAt);
    return true;
  } catch {
    return false;
  }
});
const event = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("retired_credential_observed"),
    trapId: text(128),
    at: timestamp,
    response,
  }),
  z.strictObject({
    type: z.literal("synthetic_decoy_interaction"),
    trapId: text(128),
    at: timestamp,
    response: z.literal("synthetic_decoy"),
    action: z.enum(["vault_write", "authority_denied"]),
  }),
]);
const recordsSchema = z
  .strictObject({
    v: z.literal(2),
    context: z.unknown().transform((value) => {
      const context: BoundaryValue = overlapCast(value);
      return parseRetiredCredentialContextV2(
        encodeRetiredCredentialContextV2(context),
      );
    }),
    matching: matchingSchema,
    traps: z.array(retainedTrap).max(MAX_RETIRED_TRAPS_V2),
    events: z.array(event).max(MAX_RETIRED_EVENTS_V2),
  })
  .refine(
    (value) =>
      new Set(value.traps.map((t) => t.id)).size === value.traps.length,
  );
export type RecordsV2 = z.infer<typeof recordsSchema>;
export type TrapRecordV2 = RecordsV2["traps"][number];
export type TrapEventV2 = RecordsV2["events"][number];
function unavailable(): never {
  throw new Error("Retired credential records are unavailable.");
}
/** Numbers in this V2 profile are all nonnegative safe integers; never round aliases. */
function assertRecordIntegers(raw: string): void {
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (ch === '"') {
      let end = i + 1;
      while (end < raw.length && raw.charAt(end) !== '"') {
        if (raw.charAt(end) === "\\") end++;
        end++;
      }
      if (end >= raw.length) unavailable();
      i = end;
    } else if (/[0-9+-]/.test(ch)) {
      const start = i;
      while (i + 1 < raw.length && /[0-9eE.+-]/.test(raw.charAt(i + 1))) i++;
      const length = i - start + 1;
      if (length > 16) unavailable();
      const token = raw.slice(start, i + 1);
      if (
        !/^(?:0|[1-9][0-9]*)$/.test(token) ||
        (length === 16 && token > "9007199254740991")
      )
        unavailable();
    }
  }
}
/** Bounded retained data only; no current-generation authentication/authority claim. */
export function parseRetainedRetiredCredentialRecordsV2(
  raw: string,
): RecordsV2 {
  try {
    if (!isString(raw)) unavailable();
    assertUnambiguousJson(raw, MAX_RETIRED_RECORDS_V2_BYTES);
    assertRecordIntegers(raw);
    return recordsSchema.parse(JSON.parse(raw));
  } catch {
    return unavailable();
  }
}

/** Expected canonical context wire is metadata, never a caller authentication verdict. */
export function parseRetiredCredentialRecordsV2(
  raw: string,
  expectedContextWire: string,
): RecordsV2 {
  try {
    if (!isString(raw) || !isString(expectedContextWire)) unavailable();
    const parsed = parseRetainedRetiredCredentialRecordsV2(raw);
    const expected = parseRetiredCredentialContextV2(expectedContextWire);
    if (
      encodeRetiredCredentialContextV2(parsed.context) !==
      encodeRetiredCredentialContextV2(expected)
    )
      unavailable();
    return parsed;
  } catch {
    return unavailable();
  }
}
/** Re-encode bounded RAW data only; no unbounded caller-object encoder or V1 upgrade. */
export function encodeRetiredCredentialRecordsV2(
  raw: string,
  expectedContextWire: string,
): string {
  const encoded = JSON.stringify(
    parseRetiredCredentialRecordsV2(raw, expectedContextWire),
  );
  if (new TextEncoder().encode(encoded).length > MAX_RETIRED_RECORDS_V2_BYTES)
    unavailable();
  return encoded;
}
