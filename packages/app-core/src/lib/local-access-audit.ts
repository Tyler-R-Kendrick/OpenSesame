/**
 * Sealed Access audit events for connector grants (ADR 0015).
 *
 * Browser-local durable evidence: allowlisted metadata only, redacted through
 * `@opensesame/audit`. Attribute names follow OTEL-style dotted event names and
 * the shared audit allowlist — no account login, email, repo name, or other
 * SII/PII in the payload.
 */

import { redactAuditMetadata } from "@opensesame/audit/redact";
import {
  type AuditOutcome,
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { emitActivity } from "./activity-log.js";
import { kvRefresh } from "./kv.js";
import { withLocalAccessLedgerLock } from "./local-access-ledger-lock.js";
import { LocalDirectoryError } from "./local-directory.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

const PATH = "config/access-audit";
const MAX_BYTES = 256_000;
const MAX_EVENTS = 256;

/**
 * Frozen event names — OTEL `event.name` style, never free-form. The two
 * `connection.binding.*` names are no longer written (Pages binds nothing on a
 * Host, ADR 0128) but stay readable so an older sealed trail still parses.
 */
export const ACCESS_AUDIT_EVENT_TYPES = [
  "access.connection.granted",
  "access.connection.revoked",
  "connection.binding.bound",
  "connection.binding.unbound",
  // What this device decided for a person (ADR 0162): a request raised,
  // approved, denied or withdrawn; an application signed in, refused or
  // ended; a Self-Issued sign-in approved or refused. Written by
  // `device-receipts.ts`, which is the only caller that names them.
  "access.request.created",
  "access.request.approved",
  "access.request.denied",
  "access.request.withdrawn",
  "access.sign_in.granted",
  "access.sign_in.denied",
  "access.sign_in.revoked",
  "access.siop.approved",
  "access.siop.denied",
] as const;

export type AccessAuditEventType = (typeof ACCESS_AUDIT_EVENT_TYPES)[number];

export type LocalAccessAuditEvent = {
  id: string;
  occurredAt: string;
  eventType: AccessAuditEventType;
  outcome: AuditOutcome;
  correlationId: string;
  targetType: string;
  targetId: string;
  metadata: JsonObject;
};

type WireFile = { version: 1; events: LocalAccessAuditEvent[] };

function isOutcome(value: BoundaryValue): value is AuditOutcome {
  return value === "succeeded" || value === "failed" || value === "denied";
}

function isEventType(value: BoundaryValue): value is AccessAuditEventType {
  if (!isString(value)) return false;
  for (const eventType of ACCESS_AUDIT_EVENT_TYPES) {
    if (eventType === value) return true;
  }
  return false;
}

function isAuditEvent(value: BoundaryValue): value is LocalAccessAuditEvent {
  if (!isJsonObject(value)) return false;
  return (
    isString(value.id) &&
    isString(value.occurredAt) &&
    isEventType(value.eventType) &&
    isOutcome(value.outcome) &&
    isString(value.correlationId) &&
    isString(value.targetType) &&
    isString(value.targetId) &&
    isJsonObject(value.metadata)
  );
}

function parseWire(raw: string): WireFile {
  const parsed: BoundaryValue = JSON.parse(raw);
  if (!isJsonObject(parsed) || parsed.version !== 1) {
    throw new LocalDirectoryError("Access audit file is corrupt.");
  }
  if (!Array.isArray(parsed.events) || !parsed.events.every(isAuditEvent)) {
    throw new LocalDirectoryError("Access audit events are corrupt.");
  }
  return { version: 1, events: parsed.events };
}

async function readAll(tomb: string): Promise<LocalAccessAuditEvent[]> {
  await kvRefresh(tombFileKey(tomb, PATH), MAX_BYTES * 2);
  try {
    const bytes = await readFile(tomb, PATH);
    if (bytes.length > MAX_BYTES) {
      throw new LocalDirectoryError("Access audit storage exceeds its limit.");
    }
    return parseWire(new TextDecoder().decode(bytes)).events;
  } catch (err) {
    if (err instanceof VfsError && err.code === "not-found") return [];
    throw err;
  }
}

async function writeAll(
  tomb: string,
  events: LocalAccessAuditEvent[],
): Promise<void> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version: 1, events } satisfies WireFile),
  );
  if (bytes.length > MAX_BYTES) {
    throw new LocalDirectoryError("Access audit storage exceeds its limit.");
  }
  try {
    await writeFile(tomb, PATH, bytes);
  } finally {
    notifyLocalIamChange();
  }
}

export async function listAccessAuditEvents(
  tomb: string,
): Promise<LocalAccessAuditEvent[]> {
  return readAll(tomb);
}

export type RecordAccessAuditInput = {
  eventType: AccessAuditEventType;
  outcome: AuditOutcome;
  targetType: string;
  targetId: string;
  /** Must already be ids/enums — redacted again before seal. */
  metadata?: JsonObject;
  correlationId?: string;
  /**
   * Also write the Activity feed's line for it. A caller whose decision the
   * feed already records (a request's own notes) says no and is not told twice.
   */
  activity?: boolean;
};

/**
 * Append one redacted Access audit event to the sealed vault ledger.
 * Uses the same allowlist as Identity-plane audit (ADR 0015).
 */
/** Connector, principal and policy a grant or revocation decided, if named. */
function decisionKey(event: LocalAccessAuditEvent): string | null {
  if (
    event.targetType !== "connection" ||
    (event.eventType !== "access.connection.granted" &&
      event.eventType !== "access.connection.revoked")
  )
    return null;
  const { subject, policy } = event.metadata;
  if (!isString(subject)) return null;
  return JSON.stringify([
    event.targetId,
    subject,
    isString(policy) ? policy : null,
  ]);
}

/**
 * Keep the newest MAX_EVENTS, newest first — except that a revocation which is
 * still the newest decision for its connector, principal and policy is never
 * the one trimmed: standing grants read it to stay revoked, and an aged-out
 * revocation would quietly re-issue what a person took away. Trimming a grant
 * is harmless — with no decision on the trail a standing grant is issued,
 * which is what the grant said — and since the oldest events go first, a
 * revocation a newer grant superseded is trimmed before that grant. The cap
 * still holds.
 */
function retainEvents(
  events: readonly LocalAccessAuditEvent[],
): LocalAccessAuditEvent[] {
  if (events.length <= MAX_EVENTS) return [...events];
  const seen = new Set<string>();
  const standing = new Set<LocalAccessAuditEvent>();
  for (const event of events) {
    const key = decisionKey(event);
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    if (event.eventType === "access.connection.revoked") standing.add(event);
  }
  // Slots left for everything else once every standing revocation is kept.
  let room = Math.max(0, MAX_EVENTS - standing.size);
  const kept: LocalAccessAuditEvent[] = [];
  for (const event of events) {
    if (kept.length === MAX_EVENTS) break;
    if (standing.has(event)) {
      kept.push(event);
    } else if (room > 0) {
      room -= 1;
      kept.push(event);
    }
  }
  return kept;
}

export async function recordAccessAuditEvent(
  tomb: string,
  input: RecordAccessAuditInput,
): Promise<LocalAccessAuditEvent[]> {
  const metadata = redactAuditMetadata(input.metadata);
  const event: LocalAccessAuditEvent = {
    id: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    eventType: input.eventType,
    outcome: input.outcome,
    correlationId: input.correlationId ?? crypto.randomUUID(),
    targetType: input.targetType,
    targetId: input.targetId,
    metadata,
  };
  const next = await withLocalAccessLedgerLock(
    tomb,
    "audit",
    PATH,
    MAX_BYTES * 2,
    async () => {
      const current = await readAll(tomb);
      const events = retainEvents([event, ...current]);
      await writeAll(tomb, events);
      return events;
    },
  );
  const outcome =
    event.outcome === "succeeded" || event.outcome === "denied"
      ? event.outcome
      : "failed";
  if (input.activity !== false)
    emitActivity({
      category: "access",
      type: event.eventType,
      summary: event.eventType.replaceAll(".", " "),
      outcome,
      targetType: event.targetType,
      targetId: event.targetId,
    });
  return next;
}
