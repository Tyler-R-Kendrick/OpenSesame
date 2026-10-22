/** Optional provider-side rotation relay. It sees metadata, never a secret. */
import {
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
    schedule.itemId === event.itemId
      ? {
          ...schedule,
          lastRotatedAt: at.toISOString(),
          nextDueAt: nextDue(at, schedule.intervalDays),
        }
      : schedule,
  );
  saveRotationSchedules(schedules);
  saveRotationEvents(
    loadRotationEvents().filter((candidate) => candidate.id !== event.id),
  );
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
  const run = processing.then(() => processRotationQueueNow(scope, now));
  processing = run.catch(() => undefined);
  return run;
}

async function processRotationQueueNow(
  scope: string,
  now: Date,
): Promise<RotationEvent[]> {
  const relay = rotationSeams.relay;
  const all = loadRotationEvents();
  const events = all.filter((event) => event.scope === scope);
  if (events.length === 0) return [];
  const remaining: RotationEvent[] = [];
  for (const event of events) {
    if (!relay) {
      remaining.push({
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
        continue;
      }
      remaining.push({
        ...event,
        state: "out-of-sync",
        detail: result.detail ?? "The rotation relay did not accept the event.",
      });
    } catch {
      remaining.push({
        ...event,
        state: "out-of-sync",
        detail: "The rotation relay could not be reached.",
      });
    }
  }
  saveRotationEvents([
    ...all.filter((event) => event.scope !== scope),
    ...remaining,
  ]);
  notify();
  return remaining;
}
