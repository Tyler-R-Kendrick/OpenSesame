import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  type MutableJsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
  readString,
} from "../json-boundary.js";
/**
 * Durable incident intent journal (STORE-C).
 * Intent is written before session fence activation; restart recovers the fence snapshot.
 */

import {
  type IncidentRecord,
  IncidentRecordSchema,
  type IncidentState,
} from "@opensesame/contracts/duress";
import { duressSessionFence } from "../session/fence.js";
import {
  type JournalWriteResult,
  clearJournal,
  readJournalPayload,
  recoverJournal,
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

export function loadIncidentIntent(): IncidentIntent | null {
  return readJournalPayload<IncidentIntent>(INCIDENT_INTENT_KEY);
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
  const journal = recoverJournal<IncidentIntent>(INCIDENT_INTENT_KEY);
  if (!journal) {
    return { recovered: false, intent: null } satisfies IncidentFenceRecovery;
  }
  const intent = journal.payload;
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
