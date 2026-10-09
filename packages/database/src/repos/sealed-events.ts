/**
 * Event repositories that seal what they store (ADR 0157).
 *
 * A decorator over `Repositories`, so the Postgres implementation, its schema
 * and its migrations do not change: the audit trail's metadata, the outbox
 * payload and the webhook and notification delivery payloads are sealed on the
 * way in and opened on the way out. A repository built over a sealed one sees
 * only plaintext, so the audit hash chain, computed over the plaintext event
 * before it is appended, verifies exactly as before.
 *
 * There are two ways into the outbox, and both are covered: `outbox.append`,
 * and `uow.appendOutbox` inside a transaction. The unit of work handed to a
 * transaction is wrapped, and a marker keeps the two paths from sealing a
 * payload twice.
 *
 * A queued row whose sealed value will not open (a changed key, an altered
 * row) is quarantined by itself rather than failing the pass that claimed it:
 * a drain that threw on one such row would fail again on every tick and hold
 * every newer row behind it. The row is marked dead through the queue's own
 * failure columns with a reason that names no value, and its sealed payload is
 * left as it was. The audit trail is the one read that does not skip: a listing
 * whose rows cannot be read throws, because a trail with gaps in it is not a
 * smaller trail.
 *
 * Failure text (`lastError`, the `error` of `recordFailure`) is scrubbed by
 * shape rather than sealed: the outbox reuses `lastError` as a drain-claim
 * token that SQL reads, and a delivery error is text an operator reads.
 */

import { scrubText } from "@opensesame/log-scrub";
import type {
  AuditEvent,
  JsonObject,
  NotificationDelivery,
  OutboxEvent,
  WebhookDelivery,
} from "@opensesame/os-domain";
import { EventSealError, type EventSealer } from "../event-seal.js";
import type { NewOutboxEvent, Repositories, UnitOfWork } from "./interfaces.js";

const AUDIT = "audit_events.metadata";
const OUTBOX = "outbox_events.payload";
const WEBHOOK = "webhook_deliveries.payload";
const NOTIFICATION = "notification_deliveries.payload";

/** What a quarantined row says; it names no value. */
export const UNREADABLE_REASON = "unreadable: sealed value did not open";

/**
 * The items of a claim that open. One that does not is handed to `quarantine`
 * and left out; any other failure is real and propagates.
 */
async function openReadable<T>(
  items: readonly T[],
  open: (item: T) => T,
  quarantine: (item: T) => Promise<void>,
): Promise<T[]> {
  const readable: T[] = [];
  for (const item of items) {
    try {
      readable.push(open(item));
    } catch (error) {
      if (!(error instanceof EventSealError)) throw error;
      await quarantine(item);
    }
  }
  return readable;
}

/** Units of work this module has wrapped, so a payload is sealed once. */
const wrapped = new WeakSet<UnitOfWork>();

/**
 * A copy of `base` with some members replaced. It keeps the prototype, so
 * `instanceof` and class methods still work, and copies the own members, so
 * an object spread of the result (`{ ...repos }`) still carries every
 * repository rather than only the ones replaced here.
 */
function overriding<T extends object>(base: T, own: Partial<T>): T {
  const copy: T = Object.create(Object.getPrototypeOf(base));
  return Object.assign(copy, base, own);
}

type Sealing = { sealer: EventSealer };

function openOutbox(sealer: EventSealer, event: OutboxEvent): OutboxEvent {
  return {
    ...event,
    payload: sealer.openCurrent(
      `${OUTBOX}:${event.id}`,
      event.payload,
      JSON.stringify([event.aggregateType, event.aggregateId]),
    ),
  };
}

function sealOutbox(
  sealer: EventSealer,
  event: NewOutboxEvent,
): NewOutboxEvent {
  return {
    ...event,
    payload: sealer.seal(
      `${OUTBOX}:${event.id}`,
      event.payload,
      JSON.stringify([event.aggregateType, event.aggregateId]),
    ),
  };
}

function sealedUow({ sealer }: Sealing, uow: UnitOfWork): UnitOfWork {
  if (wrapped.has(uow)) return uow;
  const sealed = overriding(uow, {
    appendOutbox: async (event: NewOutboxEvent) =>
      openOutbox(sealer, await uow.appendOutbox(sealOutbox(sealer, event))),
  });
  wrapped.add(sealed);
  return sealed;
}

function sealedAudit(
  { sealer }: Sealing,
  base: Repositories["auditEvents"],
): Repositories["auditEvents"] {
  const open = (event: AuditEvent): AuditEvent => ({
    ...event,
    metadata: sealer.openCurrent(
      `${AUDIT}:${event.id}`,
      event.metadata,
      event.organizationId ?? event.principalId ?? "deployment",
    ),
  });
  return overriding(base, {
    append: async (event: AuditEvent, uow?: UnitOfWork) =>
      open(
        await base.append(
          {
            ...event,
            metadata: sealer.seal(
              `${AUDIT}:${event.id}`,
              event.metadata,
              event.organizationId ?? event.principalId ?? "deployment",
            ),
          },
          uow,
        ),
      ),
    list: async (filter) => (await base.list(filter)).map(open),
  });
}

function sealedOutboxRepo(
  { sealer }: Sealing,
  base: Repositories["outbox"],
): Repositories["outbox"] {
  return overriding(base, {
    append: async (event: NewOutboxEvent, uow?: UnitOfWork) => {
      // Inside one of our transactions `uow.appendOutbox` seals; anywhere else
      // the payload is sealed here, once, before it is handed on.
      if (uow !== undefined && wrapped.has(uow)) return uow.appendOutbox(event);
      return openOutbox(
        sealer,
        await base.append(sealOutbox(sealer, event), uow),
      );
    },
    // A read: an unreadable row is left out, and claimed (and quarantined) by
    // the drain that reaches it.
    listUnpublished: async (limit) =>
      openReadable(
        await base.listUnpublished(limit),
        (e) => openOutbox(sealer, e),
        async () => undefined,
      ),
    claimUnpublished: async (limit, now, holdMs) =>
      openReadable(
        await base.claimUnpublished(limit, now, holdMs),
        (e) => openOutbox(sealer, e),
        (e) => base.markPublished(e.id, new Date(), UNREADABLE_REASON),
      ),
    releaseClaim: (id: string, error?: string) =>
      base.releaseClaim(id, error === undefined ? undefined : scrubText(error)),
  });
}

function sealedDeliveries<
  D extends {
    id: string;
    payload: JsonObject;
    principalId?: string;
    endpointId?: string;
  },
>(
  { sealer }: Sealing,
  purpose: string,
  base: {
    enqueue(delivery: D, uow?: UnitOfWork): Promise<D>;
    claimDue(limit: number, now: Date): Promise<D[]>;
    recordFailure(
      id: string,
      error: string,
      nextAttemptAt: Date,
      dead: boolean,
    ): Promise<void>;
  },
) {
  const open = (delivery: D): D => ({
    ...delivery,
    payload: sealer.openCurrent(
      `${purpose}:${delivery.id}`,
      delivery.payload,
      delivery.principalId ?? delivery.endpointId ?? "deployment",
    ),
  });
  return {
    enqueue: async (delivery: D, uow?: UnitOfWork) =>
      open(
        await base.enqueue(
          {
            ...delivery,
            payload: sealer.seal(
              `${purpose}:${delivery.id}`,
              delivery.payload,
              delivery.principalId ?? delivery.endpointId ?? "deployment",
            ),
          },
          uow,
        ),
      ),
    claimDue: async (limit: number, now: Date) =>
      openReadable(await base.claimDue(limit, now), open, (d) =>
        base.recordFailure(d.id, UNREADABLE_REASON, now, true),
      ),
    recordFailure: (id: string, error: string, next: Date, dead: boolean) =>
      base.recordFailure(id, scrubText(error), next, dead),
  };
}

function sealedNotifications(
  sealing: Sealing,
  base: Repositories["notificationDeliveries"],
) {
  return {
    ...sealedDeliveries<NotificationDelivery>(sealing, NOTIFICATION, base),
    // A read the sealing above must not bypass: the payload comes back open.
    listForRequest: async (authReqId: string) =>
      (await base.listForRequest(authReqId)).map((d) => ({
        ...d,
        payload: sealing.sealer.openCurrent(
          `${NOTIFICATION}:${d.id}`,
          d.payload,
          d.principalId,
        ),
      })),
  };
}

export function withSealedEvents(
  repos: Repositories,
  sealer: EventSealer,
): Repositories {
  const sealing: Sealing = { sealer };
  return overriding(repos, {
    auditEvents: sealedAudit(sealing, repos.auditEvents),
    outbox: sealedOutboxRepo(sealing, repos.outbox),
    webhookDeliveries: overriding(
      repos.webhookDeliveries,
      sealedDeliveries<WebhookDelivery>(
        sealing,
        WEBHOOK,
        repos.webhookDeliveries,
      ),
    ),
    notificationDeliveries: overriding(
      repos.notificationDeliveries,
      sealedNotifications(sealing, repos.notificationDeliveries),
    ),
    transaction: (fn) =>
      repos.transaction((uow) => fn(sealedUow(sealing, uow))),
  });
}
