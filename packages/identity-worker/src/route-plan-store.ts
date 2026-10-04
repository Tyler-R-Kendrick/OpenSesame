import type {
  JsonObject,
  NotificationClass,
  RoutePlan,
} from "@opensesame/os-domain";

/**
 * What stage 2 needs to advance a ladder it did not compute.
 *
 * Fallback may only ever choose a step that was *already in the plan*, so
 * the plan has to survive from fan-out to delivery. There is nowhere durable
 * to put it — a `NotificationDelivery` has no routing column, and the
 * rendered payload is the provider's, not ours — so it is remembered in
 * process memory, bounded, and never written down. The consequence is
 * deliberate: a worker that has forgotten the plan does not fall back at
 * all. The row dead-letters and the request stays in the durable inbox,
 * which is the failure we can live with. Guessing the next destination from
 * a policy re-derived after the fact is the one we cannot: a preference edit
 * or a default-policy stand-in could name a channel the original policy had
 * excluded.
 */
export interface RoutePlanRecord {
  plan: RoutePlan;
  notificationClass: NotificationClass;
  eventType: string;
  principalId: string;
  authReqId?: string;
  /** The outbox payload minus the routing key, re-rendered per step. */
  body: JsonObject;
}

export interface RoutePlanStore {
  get(outboxEventId: string): RoutePlanRecord | undefined;
  remember(outboxEventId: string, record: RoutePlanRecord): void;
}

const DEFAULT_PLAN_CAPACITY = 512;

/**
 * Bounded, insertion-ordered plan memory. Unbounded would be a leak in a
 * process that is expected to run for months.
 */
export function createRoutePlanStore(
  capacity: number = DEFAULT_PLAN_CAPACITY,
): RoutePlanStore {
  const entries = new Map<string, RoutePlanRecord>();
  return {
    get: (outboxEventId) => entries.get(outboxEventId),
    remember: (outboxEventId, record) => {
      entries.delete(outboxEventId);
      entries.set(outboxEventId, record);
      while (entries.size > Math.max(1, capacity)) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
  };
}
