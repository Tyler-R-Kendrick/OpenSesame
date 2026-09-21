/**
 * Sealed Access audit events for connector grants (ADR 0015).
 *
 * Browser-local durable evidence: allowlisted metadata only, redacted through
 * `@opensesame/audit`. Attribute names follow OTEL-style dotted event names and
 * the shared audit allowlist — no account login, email, repo name, or other
 * SII/PII in the payload. Host connection event free-text is sanitized before
 * display.
 */

import { redactAuditMetadata } from "@opensesame/audit/redact";
import {
  type AuditOutcome,
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import type { ConnectionEvent } from "./connections.js";
import { emitActivity } from "./activity-log.js";
import { kvRefresh } from "./kv.js";
import { LocalDirectoryError } from "./local-directory.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

const PATH = "config/access-audit";
const MAX_BYTES = 256_000;
const MAX_EVENTS = 256;

/** Frozen event names — OTEL `event.name` style, never free-form. */
export const ACCESS_AUDIT_EVENT_TYPES = [
  "access.connection.granted",
  "access.connection.revoked",
  "connection.binding.bound",
  "connection.binding.unbound",
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

/** Host `detail` values that are closed enums, not free text. */
const SAFE_CONNECTION_EVENT_DETAILS = new Set([
  "identity",
  "agent",
  "user",
  "organization",
  "project",
]);

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
};

/**
 * Append one redacted Access audit event to the sealed vault ledger.
 * Uses the same allowlist as Identity-plane audit (ADR 0015).
 */
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
  const current = await readAll(tomb);
  const next = [event, ...current].slice(0, MAX_EVENTS);
  await writeAll(tomb, next);
  const outcome =
    event.outcome === "succeeded" || event.outcome === "denied"
      ? event.outcome
      : "failed";
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

/**
 * Drop Host connection-event free text that could carry SII/PII.
 * Keeps only closed binding-target vocabulary (OTEL attribute-safe).
 */
export function sanitizeConnectionEvent(
  event: ConnectionEvent,
): ConnectionEvent {
  const detail = event.detail?.trim().toLowerCase() ?? "";
  if (detail.length === 0) {
    return { ...event, detail: null };
  }
  if (SAFE_CONNECTION_EVENT_DETAILS.has(detail)) {
    return { ...event, detail };
  }
  return { ...event, detail: null };
}

export function sanitizeConnectionEvents(
  events: ConnectionEvent[],
): ConnectionEvent[] {
  return events.map(sanitizeConnectionEvent);
}
