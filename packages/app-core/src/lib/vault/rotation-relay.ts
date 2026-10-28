/** Optional provider-side rotation relay. It sees metadata, never a secret. */
import { lockManager } from "../../ports.js";
import { kvDurability, kvGet, kvRefresh, kvSetDurable } from "../kv.js";
import {
  ROTATION_EVENT_KEY,
  ROTATION_SCHEDULE_KEY,
  type RotationEvent,
  loadRotationEvents,
  loadRotationSchedules,
  nextDue,
  notify,
  saveRotationEvents,
  saveRotationSchedules,
} from "./rotation-queue.js";

export type { RotationEvent } from "./rotation-queue.js";

export type RotationRelayResult = { ok: true } | { ok: false; detail?: string };

export type RotationRelay = (
  event: RotationEvent,
) => Promise<RotationRelayResult>;

type RotationSeams = {
  /** Installed by a future queue/relay integration. Absent is an honest state. */
  relay: RotationRelay | null;
};

export const rotationSeams: RotationSeams = { relay: null };

async function complete(event: RotationEvent, at: Date): Promise<void> {
  const schedules = loadRotationSchedules().map((schedule) =>
    schedule.scope === event.scope && schedule.itemId === event.itemId
      ? {
          ...schedule,
          lastRotatedAt: at.toISOString(),
          nextDueAt: nextDue(at, schedule.intervalDays),
        }
      : schedule,
  );
  saveRotationSchedules(schedules);
  // The queue lives outside any vault; make the schedule advance durable
  // before the event is removed, so a crash cannot retry a completed rotation.
  await kvSetDurable(
    ROTATION_SCHEDULE_KEY,
    kvGet(ROTATION_SCHEDULE_KEY) ?? "[]",
  );
}

let processing: Promise<unknown> = Promise.resolve();
const ROTATION_LOCK = "opensesame:local-rotation";
const ROTATION_STORE_BYTES = 1024 * 1024;

async function withRotationLock<T>(action: () => Promise<T>): Promise<T> {
  const run = async () => {
    // Schedules and events are origin-wide, not tomb-scoped. Refresh both
    // under one origin-wide lock or another vault's tab can overwrite them
    // from a stale in-memory copy.
    await kvRefresh(ROTATION_EVENT_KEY, ROTATION_STORE_BYTES);
    await kvRefresh(ROTATION_SCHEDULE_KEY, ROTATION_STORE_BYTES);
    return action();
  };
  const locks = lockManager();
  if (locks) return locks.request(ROTATION_LOCK, run);
  if (kvDurability() === "persistent")
    throw new Error("Web Locks are required for shared rotation writes.");
  return run();
}

/**
 * Offer every waiting event to the relay. Without one, mark the event out of
 * sync and leave it waiting; a later vault open retries it. Calls are
 * serialized so two opens cannot dispatch the same event twice.
 */
export function processRotationQueue(
  scope: string,
  now = new Date(),
): Promise<RotationEvent[]> {
  const run = processing.then(() =>
    withRotationLock(() => processRotationQueueNow(scope, now)),
  );
  processing = run.catch(() => undefined);
  return run;
}

async function processRotationQueueNow(
  scope: string,
  now: Date,
): Promise<RotationEvent[]> {
  const relay = rotationSeams.relay;
  const events = loadRotationEvents().filter((event) => event.scope === scope);
  if (events.length === 0) return [];
  const outcomes = new Map<string, RotationEvent | null>();
  for (const event of events) {
    if (!relay) {
      outcomes.set(event.id, {
        ...event,
        state: "out-of-sync",
        detail: "No rotation relay is configured on this device.",
      });
      continue;
    }
    try {
      const result = await relay(event);
      if (result.ok) {
        await complete(event, now);
        outcomes.set(event.id, null);
        continue;
      }
      outcomes.set(event.id, {
        ...event,
        state: "out-of-sync",
        detail: result.detail ?? "The rotation relay did not accept the event.",
      });
    } catch {
      outcomes.set(event.id, {
        ...event,
        state: "out-of-sync",
        detail: "The rotation relay could not be reached.",
      });
    }
  }
  // Re-read after every await: another producer may have added an event while
  // the relay was running. Only the ids this pass handled are replaced.
  const retained = loadRotationEvents().flatMap((event) => {
    if (event.scope !== scope || !outcomes.has(event.id)) return [event];
    const outcome = outcomes.get(event.id);
    return outcome === null || outcome === undefined ? [] : [outcome];
  });
  saveRotationEvents(retained);
  await kvSetDurable(ROTATION_EVENT_KEY, kvGet(ROTATION_EVENT_KEY) ?? "[]");
  notify();
  return retained.filter((event) => event.scope === scope);
}
