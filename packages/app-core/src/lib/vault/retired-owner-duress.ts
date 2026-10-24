/** Exact physical duress enrollment probe; cached absence never excludes a collision. */
import { b64ToBytes, bytesToB64 } from "@opensesame/vault-core";
import { z } from "zod";
import { assertDuressKdfParams } from "../duress/keys/pin-floors.js";
import {
  ENROLLMENT_STATE_KEY,
  journalKeysOf,
} from "../duress/store/boot-keys.js";
import { assertNotDuressCode } from "../duress/store/duress-code-probe.js";
import type { EnrollmentState } from "../duress/trigger/enrollment-state.js";
import { assertUnambiguousJson } from "../retired-credentials/json-preflight.js";
import type { PhysicalDeviceRecordReader } from "./physical-device-record-port.js";
const text = z.string().min(1).max(512);
const integer = z.number().int().nonnegative().safe();
const slot = z.strictObject({
  version: z.literal(1),
  slotId: text,
  profileId: text,
  vaultRef: text,
  deviceBindingRef: text,
  policyRevision: integer,
  keyEpoch: integer,
  saltB64: z.string().max(128),
  ivB64: z.string().max(128),
  ciphertextB64: z.string().min(1).max(100000),
  iterations: integer.max(10000000),
});
const trigger = z.strictObject({
  slot,
  triggerKind: z.enum([
    "application_code",
    "verified_uv_then_code",
    "prf_and_code",
  ]),
  prfEnvelope: z
    .strictObject({
      version: z.literal(1),
      profileId: text,
      vaultRef: text,
      policyRevision: integer,
      keyEpoch: integer,
      saltB64: z.string().max(128),
      outerIvB64: z.string().max(128),
      outerCtB64: z.string().max(100000),
      iterations: integer.max(10000000),
    })
    .optional(),
  prfEnvelopeRef: text.optional(),
  credentialIdB64: z.string().max(2048).optional(),
  expectedOrigin: text.optional(),
  prfSaltB64: z.string().max(128).optional(),
});
const state = z.strictObject({
  vaultRef: text,
  deviceBindingRef: text,
  policyRevision: integer,
  keyEpoch: integer,
  triggers: z.array(trigger).max(8),
  ordinaryCodeFingerprints: z.array(z.string().max(256)).max(64),
  rehearsalPassed: z.boolean(),
  ownerConsent: z.boolean(),
  armed: z.boolean().optional(),
  capabilities: z
    .strictObject({
      durableLocalStorage: z.boolean(),
      prfAvailable: z.boolean(),
      userVerificationAvailable: z.boolean(),
      offlineReady: z.boolean(),
    })
    .optional(),
});
const journal = z.strictObject({
  schemaVersion: z.literal(1),
  revision: integer,
  updatedAt: text,
  payload: state,
});
function canonicalSlotBytes(wire: string, length: number | undefined) {
  const bytes = b64ToBytes(wire);
  if (
    bytesToB64(bytes) !== wire ||
    (length === undefined ? bytes.length < 16 : bytes.length !== length)
  )
    throw new Error("Duress slot encoding is malformed.");
}
function checkSlotEncoding(record: z.infer<typeof slot>) {
  assertDuressKdfParams(record);
  canonicalSlotBytes(record.saltB64, 16);
  canonicalSlotBytes(record.ivB64, 12);
  canonicalSlotBytes(record.ciphertextB64, undefined);
}
export const ORIGINAL_DURESS_KEYS = journalKeysOf(ENROLLMENT_STATE_KEY);
export async function captureOriginalDuressCollisionData(
  reader: PhysicalDeviceRecordReader,
  check: () => void,
) {
  const read = async () => {
    const values: (string | null)[] = [];
    for (const key of ORIGINAL_DURESS_KEYS) {
      values.push(await reader.read(key, 1048576));
      check();
    }
    return values;
  };
  const values = await read();
  const [raw, staging, commit] = values;
  if (staging !== null || commit !== null)
    throw new Error("Duress enrollment is changing; retry after it settles.");
  const payload = parseOriginalDuressEnrollment(raw);
  const revalidate = async () => {
    if (JSON.stringify(await read()) !== JSON.stringify(values))
      throw new Error("Duress enrollment changed.");
    await reader.revalidateRoot();
    check();
  };
  return Object.freeze({
    revalidate,
    async refuse(candidate: string) {
      await revalidate();
      await assertNotDuressCode(candidate, payload);
      check();
      await revalidate();
    },
  });
}

function parseOriginalDuressEnrollment(
  raw: string | null | undefined,
): EnrollmentState | null {
  if (raw !== null && raw !== undefined) assertUnambiguousJson(raw, 1048576);
  const parsed =
    raw === null ? null : journal.parse(JSON.parse(raw ?? "")).payload;
  if (parsed === null) return null;
  const payload: EnrollmentState = {
    vaultRef: parsed.vaultRef,
    deviceBindingRef: parsed.deviceBindingRef,
    policyRevision: parsed.policyRevision,
    keyEpoch: parsed.keyEpoch,
    triggers: parsed.triggers,
    ordinaryCodeFingerprints: parsed.ordinaryCodeFingerprints,
    rehearsalPassed: parsed.rehearsalPassed,
    ownerConsent: parsed.ownerConsent,
  };
  if (parsed.armed !== undefined) payload.armed = parsed.armed;
  if (parsed.capabilities !== undefined)
    payload.capabilities = parsed.capabilities;
  if (payload)
    for (const row of payload.triggers) {
      checkSlotEncoding(row.slot);
      if (
        row.slot.vaultRef !== payload.vaultRef ||
        row.slot.deviceBindingRef !== payload.deviceBindingRef ||
        row.slot.policyRevision !== payload.policyRevision ||
        row.slot.keyEpoch !== payload.keyEpoch
      )
        throw new Error("Duress enrollment binding is inconsistent.");
    }
  return payload;
}
