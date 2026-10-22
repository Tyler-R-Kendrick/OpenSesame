/** Optional provider-side rotation relay. It sees metadata, never a secret. */
import { withLocalAccessLedgerLock } from "../local-access-ledger-lock.js";
import {
  ROTATION_EVENT_KEY,
  type RotationEvent,
  loadRotationEvents,
  loadRotationSchedules,
  nextDue,
  notify,
  saveRotationEvents,
  saveRotationSchedules,
} from "./rotation-queue.js";

export type RotationRelayResult = { ok: true } | { ok: false; detail?: string };

export type RotationRelay = (
  event: RotationEvent,
) => Promise<RotationRelayResult>;

export const rotationSeams = {
  /** Installed by a future queue/relay integration. Absent is an honest state. */
  relay: null as RotationRelay | null,
};

function complete(event: RotationEvent, at: Date): void {
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
}

let processing: Promise<unknown> = Promise.resolve();

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
    withLocalAccessLedgerLock(
      scope,
      "rotation",
      ROTATION_EVENT_KEY,
      1024 * 1024,
      () => processRotationQueueNow(scope, now),
    ),
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
        complete(event, now);
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
  notify();
  return retained.filter((event) => event.scope === scope);
}
