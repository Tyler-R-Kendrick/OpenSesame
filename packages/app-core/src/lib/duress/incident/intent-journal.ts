import type { BoundaryValue } from "../json-boundary.js";
/**
 * Durable incident intent journal (STORE-C).
 * Intent is written before session fence activation; restart recovers the fence snapshot.
 */

import {
  DURESS_BOUNDS,
  type IncidentRecord,
  IncidentRecordSchema,
  type IncidentState,
} from "@opensesame/contracts/duress";
import { z } from "zod";
import { duressSessionFence } from "../session/fence.js";
import {
  type JournalWriteResult,
  clearJournal,
  readJournalPayload,
  writeJournal,
} from "../store/journal.js";
import { parseIncidentRecord } from "../store/storage-resilience.js";

export const INCIDENT_INTENT_KEY = "duress.incident-intent.v1";
export const INCIDENT_RECORD_KEY = "duress.incident-record.v1";

export type IncidentIntent = Readonly<{
  incidentId: string;
  profileId: string;
  policyRevision: number;
  keyEpoch: number;
  state: IncidentState;
  presentation: "normal" | "restricted" | "decoy" | "locked" | "unchanged";
  admittedCompartmentRefs: readonly string[];
  denyOperations: readonly string[];
  scopeSnapshot: IncidentRecord["scopeSnapshot"];
  activationEvidenceDigest: string;
  /** True once local fence was applied in this browser session. */
  fenceApplied: boolean;
}>;

const IntentRefSchema = z
  .string()
  .min(DURESS_BOUNDS.refMin)
  .max(DURESS_BOUNDS.refMax)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);

const IntentRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(DURESS_BOUNDS.revisionMax);

export const IncidentIntentSchema = z
  .object({
    incidentId: IntentRefSchema,
    profileId: IntentRefSchema,
    policyRevision: IntentRevisionSchema,
    keyEpoch: IntentRevisionSchema,
    state: z.enum(["active", "recovery_requested", "resolved", "superseded"]),
    presentation: z.enum([
      "normal",
      "restricted",
      "decoy",
      "locked",
      "unchanged",
    ]),
    admittedCompartmentRefs: z
      .array(IntentRefSchema)
      .max(DURESS_BOUNDS.compartmentRefsMax),
    denyOperations: z
      .array(z.string().min(1).max(DURESS_BOUNDS.refMax))
      .max(DURESS_BOUNDS.compartmentRefsMax),
    scopeSnapshot: z
      .object({
        vaultRef: IntentRefSchema,
        deviceBindingRef: IntentRefSchema,
        compartmentRefs: z
          .array(IntentRefSchema)
          .min(1)
          .max(DURESS_BOUNDS.compartmentRefsMax),
      })
      .strict(),
    activationEvidenceDigest: z
      .string()
      .min(DURESS_BOUNDS.digestMin)
      .max(DURESS_BOUNDS.digestMax),
    fenceApplied: z.boolean(),
  })
  .strict();

export function loadIncidentIntent(): IncidentIntent | null {
  return readValidatedIntent();
}

function readValidatedIntent(): IncidentIntent | null {
  const payload = readJournalPayload<BoundaryValue>(INCIDENT_INTENT_KEY);
  if (!payload) return null;
  const parsed = IncidentIntentSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

type IntentWriteOptions = Readonly<{
  requireDurable?: boolean;
  expectedRevision?: number;
}>;
const defaultIntentWriteOptions = {} satisfies IntentWriteOptions;

export async function writeIncidentIntent(
  intent: IncidentIntent,
  options: IntentWriteOptions = defaultIntentWriteOptions,
): Promise<JournalWriteResult> {
  return writeJournal(INCIDENT_INTENT_KEY, intent, {
    requireDurable: options.requireDurable ?? true,
    expectedRevision: options.expectedRevision,
  });
}

type RecordWriteOptions = Readonly<{ requireDurable?: boolean }>;
const defaultRecordWriteOptions = {} satisfies RecordWriteOptions;

export async function writeIncidentRecord(
  record: IncidentRecord,
  options: RecordWriteOptions = defaultRecordWriteOptions,
): Promise<JournalWriteResult> {
  const checked = IncidentRecordSchema.safeParse(record);
  if (!checked.success) {
    return {
      ok: false,
      code: "interrupted_write",
      message: checked.error.message,
    };
  }
  return writeJournal(INCIDENT_RECORD_KEY, checked.data, {
    requireDurable: options.requireDurable ?? true,
  });
}

export function loadIncidentRecord(): IncidentRecord | null {
  const payload = readJournalPayload<BoundaryValue>(INCIDENT_RECORD_KEY);
  if (!payload) return null;
  const parsed = parseIncidentRecord(payload);
  return parsed.ok ? parsed.record : null;
}

/**
 * After restart: recover durable intent and rehydrate the in-memory fence.
 * Does not unwrap any vault root (INV no premature root release).
 */
export type IncidentFenceRecovery = Readonly<{
  recovered: boolean;
  intent: IncidentIntent | null;
}>;

export function recoverIncidentFenceAfterRestart(): IncidentFenceRecovery {
  const intent = readValidatedIntent();
  if (!intent) {
    return { recovered: false, intent: null } satisfies IncidentFenceRecovery;
  }
  if (intent.state !== "active" && intent.state !== "recovery_requested") {
    return { recovered: true, intent } satisfies IncidentFenceRecovery;
  }
  const fence = duressSessionFence.readFence();
  if (!fence.activeIncidentIds.includes(intent.incidentId)) {
    duressSessionFence.activate({
      incidentId: intent.incidentId,
      policyRevision: intent.policyRevision,
      keyEpoch: intent.keyEpoch,
      denyOperations: intent.denyOperations,
      admittedCompartmentRefs: intent.admittedCompartmentRefs,
    });
  }
  return { recovered: true, intent } satisfies IncidentFenceRecovery;
}

export function clearIncidentJournals(): void {
  clearJournal(INCIDENT_INTENT_KEY);
  clearJournal(INCIDENT_RECORD_KEY);
}
