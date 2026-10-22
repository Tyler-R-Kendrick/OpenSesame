/**
 * Rotation queue and schedules.
 *
 * The vault may be locked when a rotation comes due, so the schedule and the
 * queue live outside the sealed body: they carry an item id, the item type,
 * timestamps, and a reason. They never carry a secret, a candidate, a name, or
 * a provider response.
 *
 * A tick can therefore queue a due account while the vault is locked. The next
 * time the vault is opened, the queue is offered to a relay. With no relay
 * configured the item stays visibly out of sync rather than pretending a
 * provider change happened.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  DEFAULT_ROTATION_INTERVAL_DAYS,
  type VaultItem,
  itemHasGenerator,
  itemRotationMode,
  itemTypeId,
} from "@opensesame/vault-core";
import { kvGet, kvSet } from "../kv.js";

export const ROTATION_SCHEDULE_KEY = "vault.rotation.schedules.v1";
export const ROTATION_EVENT_KEY = "vault.rotation.events.v1";
export const ROTATION_INTERVAL_DAYS = DEFAULT_ROTATION_INTERVAL_DAYS;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EVENTS = 256;

/** The relying-party origin a web login can target, or null. */
export function accountWebLoginOrigin(item: VaultItem): string | null {
  if (item.kind !== "account") return null;
  for (const entry of item.uris) {
    try {
      const url = new URL(entry.uri);
      if (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        !url.hostname.includes("*")
      )
        return url.origin;
    } catch {
      // A non-URL match rule is not a relying party.
    }
  }
  return null;
}

export type RotationSchedule = {
  scope: string;
  itemId: string;
  typeId: string;
  enabled: boolean;
  intervalDays: number;
  lastRotatedAt: string;
  nextDueAt: string;
};

export type RotationEventState = "queued" | "out-of-sync";

export type RotationEvent = {
  id: string;
  scope: string;
  itemId: string;
  typeId: string;
  reason: "scheduled" | "manual";
  queuedAt: string;
  dueAt: string;
  state: RotationEventState;
  detail: string | null;
};

const listeners = new Set<() => void>();

export function subscribeRotationQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notify(): void {
  for (const listener of listeners) listener();
}

function readArray(key: string): BoundaryValue[] {
  const raw = kvGet(key);
  if (!raw) return [];
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isIso(value: BoundaryValue): value is string {
  return isString(value) && !Number.isNaN(Date.parse(value));
}

function parseSchedule(value: BoundaryValue): RotationSchedule | null {
  if (!isJsonObject(value)) return null;
  if (!isString(value.itemId) || !isString(value.typeId)) return null;
  if (!isString(value.scope)) return null;
  if (!isIso(value.lastRotatedAt) || !isIso(value.nextDueAt)) return null;
  if (typeof value.enabled !== "boolean") return null;
  if (
    typeof value.intervalDays !== "number" ||
    !Number.isFinite(value.intervalDays)
  )
    return null;
  return {
    scope: value.scope,
    itemId: value.itemId,
    typeId: value.typeId,
    enabled: value.enabled,
    intervalDays: Math.max(1, Math.trunc(value.intervalDays)),
    lastRotatedAt: value.lastRotatedAt,
    nextDueAt: value.nextDueAt,
  };
}

function parseEvent(value: BoundaryValue): RotationEvent | null {
  if (!isJsonObject(value)) return null;
  if (!isString(value.id) || !isString(value.itemId) || !isString(value.typeId))
    return null;
  if (!isString(value.scope)) return null;
  if (value.reason !== "scheduled" && value.reason !== "manual") return null;
  if (value.state !== "queued" && value.state !== "out-of-sync") return null;
  if (!isIso(value.queuedAt) || !isIso(value.dueAt)) return null;
  if (value.detail !== null && !isString(value.detail)) return null;
  return {
    id: value.id,
    scope: value.scope,
    itemId: value.itemId,
    typeId: value.typeId,
    reason: value.reason,
    queuedAt: value.queuedAt,
    dueAt: value.dueAt,
    state: value.state,
    detail: value.detail,
  };
}

export function loadRotationSchedules(): RotationSchedule[] {
  const schedules: RotationSchedule[] = [];
  for (const row of readArray(ROTATION_SCHEDULE_KEY)) {
    const schedule = parseSchedule(row);
    if (schedule) schedules.push(schedule);
  }
  return schedules;
}

export function saveRotationSchedules(
  schedules: readonly RotationSchedule[],
): void {
  kvSet(ROTATION_SCHEDULE_KEY, JSON.stringify(schedules));
}

export function loadRotationEvents(): RotationEvent[] {
  const events: RotationEvent[] = [];
  for (const row of readArray(ROTATION_EVENT_KEY)) {
    const event = parseEvent(row);
    if (event) events.push(event);
  }
  return events;
}

export function saveRotationEvents(events: readonly RotationEvent[]): void {
  kvSet(ROTATION_EVENT_KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
}

export function rotationScheduleFor(
  scope: string,
  itemId: string,
): RotationSchedule | null {
  return (
    loadRotationSchedules().find(
      (schedule) => schedule.scope === scope && schedule.itemId === itemId,
    ) ?? null
  );
}

export function rotationEventFor(
  scope: string,
  itemId: string,
): RotationEvent | null {
  return (
    loadRotationEvents().find(
      (event) => event.scope === scope && event.itemId === itemId,
    ) ?? null
  );
}

/** Create the default schedule for one item when no vault-wide sync has run yet. */
export function ensureRotationSchedule(
  item: VaultItem,
  scope: string,
  now = new Date(),
): RotationSchedule | null {
  if (!scope) return null;
  const typeId = itemTypeId(item);
  if (itemRotationMode(typeId) !== "automatic") return null;
  if (!accountWebLoginOrigin(item)) return null;
  const existing = rotationScheduleFor(scope, item.id);
  if (existing && existing.typeId === typeId) return existing;
  const schedule: RotationSchedule = {
    scope,
    itemId: item.id,
    typeId,
    enabled: true,
    intervalDays: ROTATION_INTERVAL_DAYS,
    lastRotatedAt: now.toISOString(),
    nextDueAt: nextDue(now, ROTATION_INTERVAL_DAYS),
  };
  saveRotationSchedules([
    ...loadRotationSchedules().filter(
      (entry) => entry.scope !== scope || entry.itemId !== item.id,
    ),
    schedule,
  ]);
  notify();
  return schedule;
}

export function nextDue(from: Date, intervalDays: number): string {
  return new Date(from.getTime() + intervalDays * DAY_MS).toISOString();
}

/**
 * Give every automatic type its default schedule and forget schedules whose
 * item is gone or whose type no longer supports automatic rotation. Existing
 * choices are retained, including a schedule the person disabled.
 */
export function syncRotationSchedules(
  items: readonly VaultItem[],
  scope: string,
  now = new Date(),
): RotationSchedule[] {
  if (!scope) return loadRotationSchedules();
  const all = loadRotationSchedules();
  const current = new Map(
    all
      .filter((schedule) => schedule.scope === scope)
      .map((schedule) => [schedule.itemId, schedule]),
  );
  const present = new Set<string>();
  const automatic = new Set<string>();
  const next: RotationSchedule[] = [];
  for (const item of items) {
    if (item.deletedAt) continue;
    present.add(item.id);
    const typeId = itemTypeId(item);
    if (itemRotationMode(typeId) !== "automatic") continue;
    if (!accountWebLoginOrigin(item)) continue;
    automatic.add(item.id);
    const existing = current.get(item.id);
    next.push(
      existing && existing.typeId === typeId
        ? existing
        : {
            scope,
            itemId: item.id,
            typeId,
            enabled: true,
            intervalDays: ROTATION_INTERVAL_DAYS,
            lastRotatedAt: now.toISOString(),
            nextDueAt: nextDue(now, ROTATION_INTERVAL_DAYS),
          },
    );
  }
  saveRotationSchedules([
    ...all.filter((schedule) => schedule.scope !== scope),
    ...next,
  ]);
  // A scheduled event survives only while its item is still automatic.
  // A manual event survives while the item and its generator still exist.
  const priorEvents = loadRotationEvents();
  const events = priorEvents.filter((event) => {
    if (event.scope !== scope) return true;
    if (!present.has(event.itemId)) return false;
    return event.reason === "scheduled"
      ? automatic.has(event.itemId)
      : itemHasGenerator(event.typeId);
  });
  saveRotationEvents(events);
  if (next.length !== current.size || events.length !== priorEvents.length)
    notify();
  return next;
}

function enqueue(
  item: Pick<VaultItem, "id">,
  scope: string,
  typeId: string,
  reason: RotationEvent["reason"],
  dueAt: string,
  now: Date,
): RotationEvent {
  const existing = rotationEventFor(scope, item.id);
  if (existing) return existing;
  const event: RotationEvent = {
    id: crypto.randomUUID(),
    scope,
    itemId: item.id,
    typeId,
    reason,
    queuedAt: now.toISOString(),
    dueAt,
    state: "queued",
    detail: null,
  };
  const events = [...loadRotationEvents(), event];
  saveRotationEvents(events);
  notify();
  return event;
}

/**
 * Queue one event per due item. Safe to call while the vault is locked: the
 * schedules and events contain no vault data. A duplicate is rolled up into
 * the event already waiting for that item.
 */
export function tickRotationSchedules(now = new Date()): RotationEvent[] {
  const due: RotationEvent[] = [];
  for (const schedule of loadRotationSchedules()) {
    if (!schedule.enabled) continue;
    if (Date.parse(schedule.nextDueAt) > now.getTime()) continue;
    due.push(
      enqueue(
        { id: schedule.itemId },
        schedule.scope,
        schedule.typeId,
        "scheduled",
        schedule.nextDueAt,
        now,
      ),
    );
  }
  return due;
}

/** A person asked for a rotation now; still only a queue entry until a relay answers. */
export function enqueueManualRotation(
  item: VaultItem,
  scope: string,
  now = new Date(),
): RotationEvent | null {
  if (!scope) return null;
  const typeId = itemTypeId(item);
  if (!itemHasGenerator(typeId)) return null;
  return enqueue(item, scope, typeId, "manual", now.toISOString(), now);
}

export function setRotationEnabled(
  scope: string,
  itemId: string,
  enabled: boolean,
): RotationSchedule | null {
  let found: RotationSchedule | null = null;
  const schedules = loadRotationSchedules().map((schedule) => {
    if (schedule.scope !== scope || schedule.itemId !== itemId) return schedule;
    found = { ...schedule, enabled };
    return found;
  });
  if (found) {
    saveRotationSchedules(schedules);
    if (!enabled) {
      saveRotationEvents(
        loadRotationEvents().filter(
          (event) =>
            event.scope !== scope ||
            event.itemId !== itemId ||
            event.reason === "manual",
        ),
      );
    }
    notify();
  }
  return found;
}

/** Test and reset seam: queue and schedules only, never item contents. */
export function clearRotationQueue(): void {
  kvSet(ROTATION_SCHEDULE_KEY, "[]");
  kvSet(ROTATION_EVENT_KEY, "[]");
  notify();
}
