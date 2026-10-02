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
import { lockManager } from "../ports.js";
import { kvDurability, kvRefresh } from "./kv.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

export const ACTIVITY_LOG_PATH = "config/activity-log";

const MAX_EVENTS = 500;
const MAX_LOG_BYTES = 1_048_576;

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

const chains = new Map<string, Promise<unknown>>();

function withActivityLogLock<T>(
  tomb: string,
  action: () => Promise<T>,
): Promise<T> {
  const name = `opensesame:activity-log:${tomb}`;
  const run = (chains.get(name) ?? Promise.resolve()).then(async () => {
    const key = tombFileKey(tomb, ACTIVITY_LOG_PATH);
    const locks = lockManager();
    if (locks)
      return locks.request(name, async () => {
        await kvRefresh(key, MAX_LOG_BYTES);
        return action();
      });
    await kvRefresh(key, MAX_LOG_BYTES);
    if (kvDurability() === "persistent")
      throw new Error("Web Locks are required for shared activity writes.");
    return action();
  });
  chains.set(
    name,
    run.catch(() => undefined),
  );
  return run;
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

/**
 * One save is one fact. `vault.login.created` qualifies; `vault.body.persisted`
 * and `vault.unlocked` do not, and those still fold.
 */
const ITEM_SAVE_TYPE = /^vault\.[^.]+\.(?:created|updated)$/u;

function repeats(
  last: ActivityEvent | undefined,
  next: ActivityEvent,
): boolean {
  if (!last || ITEM_SAVE_TYPE.test(next.type)) return false;
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

/**
 * Per tomb, so a body-saved note and the item note that follows it both
 * read the log the other one just wrote. Unchained, each reads the old
 * file and one write replaces the other.
 */
const activityWrites = new Map<string, Promise<void>>();

async function appendActivityEvent(
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
  let wrote = false;
  const next = await withActivityLogLock(tomb, async () => {
    const current = await readAll(tomb);
    // A burst of the same event (an invalidation fired once per store it
    // touched, a ledger written on every render) is one line, not fifteen.
    if (repeats(current[0], event)) return current;
    const merged = [event, ...current].slice(0, MAX_EVENTS);
    await writeAll(tomb, merged);
    wrote = true;
    return merged;
  });
  if (wrote) notify();
  return next;
}

export function recordActivityEvent(
  tomb: string,
  input: RecordActivityInput,
): Promise<ActivityEvent[]> {
  const previous = activityWrites.get(tomb) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(() => appendActivityEvent(tomb, input));
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  activityWrites.set(tomb, settled);
  void settled.finally(() => {
    if (activityWrites.get(tomb) === settled) activityWrites.delete(tomb);
  });
  return run;
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
