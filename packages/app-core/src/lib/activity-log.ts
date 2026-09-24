/**
 * Durable app activity log (sealed in the vault).
 *
 * Every consequential Pages event — settings, access requests, vault lifecycle,
 * wallet journal mirrors, connection grants — appends here so `/activity` is
 * the single durable trail (not a wallet budget journal).
 */

import { redactAuditMetadata } from "@opensesame/audit/redact";
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { VfsError, readFile, writeFile } from "./vfs.js";

export const ACTIVITY_LOG_PATH = "config/activity-log";

const MAX_EVENTS = 500;

export const ACTIVITY_CATEGORIES = [
  "settings",
  "access",
  "vault",
  "wallet",
  "identity",
  "connection",
  "request",
  "system",
] as const;

export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export type ActivityOutcome = "succeeded" | "failed" | "denied" | "info";

export type ActivityEvent = {
  id: string;
  occurredAt: string;
  category: ActivityCategory;
  type: string;
  summary: string;
  outcome: ActivityOutcome;
  targetType: string | null;
  targetId: string | null;
  metadata: JsonObject;
};

export type RecordActivityInput = {
  category: ActivityCategory;
  type: string;
  summary: string;
  outcome?: ActivityOutcome;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: JsonObject;
};

type WireFile = { version: 1; events: ActivityEvent[] };

const listeners = new Set<() => void>();

export const activitySeams = {
  /** Active unlocked tomb (a guest's included), or null when locked. */
  activeTomb: (): string | null => null,
};

function isCategory(value: BoundaryValue): value is ActivityCategory {
  if (!isString(value)) return false;
  for (const category of ACTIVITY_CATEGORIES) {
    if (category === value) return true;
  }
  return false;
}

function isOutcome(value: BoundaryValue): value is ActivityOutcome {
  return (
    value === "succeeded" ||
    value === "failed" ||
    value === "denied" ||
    value === "info"
  );
}

function isActivityEvent(value: BoundaryValue): value is ActivityEvent {
  if (!isJsonObject(value)) return false;
  return (
    isString(value.id) &&
    isString(value.occurredAt) &&
    isCategory(value.category) &&
    isString(value.type) &&
    isString(value.summary) &&
    isOutcome(value.outcome) &&
    (value.targetType === null || isString(value.targetType)) &&
    (value.targetId === null || isString(value.targetId)) &&
    isJsonObject(value.metadata)
  );
}

function parseWire(raw: string): ActivityEvent[] {
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isJsonObject(parsed) || parsed.version !== 1) return [];
  if (!Array.isArray(parsed.events)) return [];
  const events: ActivityEvent[] = [];
  for (const row of parsed.events) {
    if (isActivityEvent(row)) events.push(row);
  }
  return events;
}

async function readAll(tomb: string): Promise<ActivityEvent[]> {
  try {
    const bytes = await readFile(tomb, ACTIVITY_LOG_PATH);
    return parseWire(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return [];
    throw error;
  }
}

async function writeAll(tomb: string, events: ActivityEvent[]): Promise<void> {
  const wire: WireFile = { version: 1, events };
  await writeFile(
    tomb,
    ACTIVITY_LOG_PATH,
    new TextEncoder().encode(JSON.stringify(wire)),
  );
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function listActivityEvents(
  tomb: string,
): Promise<ActivityEvent[]> {
  return readAll(tomb);
}

/** How close together two identical events fold into the first. */
const REPEAT_WINDOW_MS = 60_000;

function repeats(
  last: ActivityEvent | undefined,
  next: ActivityEvent,
): boolean {
  if (!last) return false;
  if (
    last.type !== next.type ||
    last.summary !== next.summary ||
    last.outcome !== next.outcome ||
    last.targetId !== next.targetId
  ) {
    return false;
  }
  const gap = Date.parse(next.occurredAt) - Date.parse(last.occurredAt);
  return gap >= 0 && gap < REPEAT_WINDOW_MS;
}

export async function recordActivityEvent(
  tomb: string,
  input: RecordActivityInput,
): Promise<ActivityEvent[]> {
  const metadata = redactAuditMetadata(input.metadata ?? {});
  const event: ActivityEvent = {
    id: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    category: input.category,
    type: input.type.trim() || "system.unknown",
    summary: input.summary.trim() || input.type,
    outcome: input.outcome ?? "info",
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    metadata,
  };
  const current = await readAll(tomb);
  // A burst of the same event (an invalidation fired once per store it
  // touched, a ledger written on every render) is one line, not fifteen.
  if (repeats(current[0], event)) return current;
  const next = [event, ...current].slice(0, MAX_EVENTS);
  await writeAll(tomb, next);
  notify();
  return next;
}

/**
 * Fire-and-forget append against the unlocked vault. No-ops when locked
 * or the write fails — activity must never block a primary action.
 */

export function noteConnectionCreated(connectionId: string): void {
  noteActivity(
    "connection",
    "connection.created",
    "Connection created",
    "succeeded",
    "connection",
    connectionId,
  );
}

export function noteConnectionRevoked(connectionId: string): void {
  noteActivity(
    "connection",
    "connection.revoked",
    "Connection revoked",
    "succeeded",
    "connection",
    connectionId,
  );
}

export function noteSettingsUpdated(): void {
  noteActivity("settings", "settings.updated", "Settings updated");
}

export function noteVaultUnlocked(): void {
  noteActivity("vault", "vault.unlocked", "Vault unlocked");
}

export function noteVaultBodyPersisted(): void {
  noteActivity("vault", "vault.body.persisted", "Vault body saved");
}

export function noteInboundRequestCreated(requestId: string): void {
  noteActivity(
    "request",
    "request.inbound.created",
    "Inbound access request received",
    "info",
    "access_request",
    requestId,
  );
}

export function noteInboundRequestDecision(
  requestId: string,
  approved: boolean,
): void {
  noteActivity(
    "request",
    approved ? "request.inbound.approved" : "request.inbound.denied",
    approved
      ? "Inbound access request approved"
      : "Inbound access request denied",
    approved ? "succeeded" : "denied",
    "access_request",
    requestId,
  );
}

export function noteActivity(
  category: ActivityCategory,
  type: string,
  summary: string,
  outcome: ActivityOutcome = "succeeded",
  targetType: string | null = null,
  targetId: string | null = null,
): void {
  emitActivity({ category, type, summary, outcome, targetType, targetId });
}

export function emitActivity(input: RecordActivityInput): void {
  const tomb = activitySeams.activeTomb();
  if (!tomb) return;
  void recordActivityEvent(tomb, input).catch(() => {
    // Durable log is best-effort beside the action.
  });
}
