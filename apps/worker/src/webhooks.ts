import { randomUUID } from "node:crypto";
import type {
  WebhookDeliveryRepository,
  WebhookEndpointRepository,
} from "@opensesame/database";
import type { Logger } from "@opensesame/observability";
import { type OutboxEvent, readString } from "@opensesame/os-domain";
import { signWebhook } from "@opensesame/webhooks";

/**
 * Webhook dispatch for the authorization-request inbox (ADR 0046 decision 12).
 *
 * Two stages, both run from the cleanup tick:
 *
 * 1. **Fan-out** — an outbox event of the two inbox types becomes one durable
 *    `webhook_deliveries` row per endpoint the approver has registered. The
 *    outbox stays the source of truth; a receiver that is down retries with
 *    backoff instead of silently missing the event.
 * 2. **Delivery** — due rows are claimed (attempts counted on claim, so a
 *    crash mid-send still burned a try), POSTed with Standard Webhooks
 *    signatures, and either marked delivered or rescheduled. After the cap
 *    the row is dead-lettered: an endpoint that has been down for the whole
 *    backoff ladder is not coming back for this event, and the inbox itself
 *    remains pollable either way.
 *
 * Payloads carry digest-shaped keys only. The event is a doorbell, not the
 * door: a receiver that wants the request reads its own inbox with its own
 * credentials.
 */

export const WEBHOOK_EVENT_TYPES = [
  "authority.invocation.requested",
  "authority.invocation.completed",
] as const;

export const MAX_DELIVERY_ATTEMPTS = 8;
const FIRST_RETRY_MS = 30_000;
const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * The two repositories this dispatcher touches, and no more.
 *
 * Named narrowly rather than as the whole `Repositories` bundle so the
 * generalized notification router can hand it the same slice it holds, and
 * so nothing here can reach the authorization request itself: a webhook
 * dispatcher that could settle a request would be a doorbell wired to the
 * lock.
 */
export interface WebhookDispatchRepos {
  webhookEndpoints: Pick<
    WebhookEndpointRepository,
    "listForPrincipal" | "getById"
  >;
  webhookDeliveries: Pick<
    WebhookDeliveryRepository,
    "enqueue" | "claimDue" | "markDelivered" | "recordFailure"
  >;
}

export interface WebhookDispatchDeps {
  repos: WebhookDispatchRepos;
  clock: () => Date;
  /** Injected for tests; the worker passes global fetch. */
  fetchImpl?: typeof fetch;
  log?: Logger;
}

function isInboxEvent(event: OutboxEvent): boolean {
  return WEBHOOK_EVENT_TYPES.some((type) => type === event.eventType);
}

/** Exponential backoff from the attempt number already counted on claim. */
export function nextAttemptDelayMs(attempts: number): number {
  return FIRST_RETRY_MS * 2 ** Math.max(0, attempts - 1);
}

/**
 * Stage 1: fan an inbox outbox-event out to the approver's endpoints.
 * Returns how many deliveries were enqueued. Safe to call for any event —
 * non-inbox types fan out to nothing.
 */
export async function fanOutWebhooks(
  deps: WebhookDispatchDeps,
  event: OutboxEvent,
): Promise<number> {
  if (!isInboxEvent(event)) return 0;
  const principalId = readString(event.payload.principalId);
  if (!principalId) return 0;
  const endpoints =
    await deps.repos.webhookEndpoints.listForPrincipal(principalId);
  const now = deps.clock();
  // The receiver-facing payload drops the routing key: an endpoint already
  // knows whose inbox it registered for, and the digest-shaped rest is what
  // the ADR allows on this surface.
  const { principalId: _routing, ...payload } = event.payload;
  let enqueued = 0;
  for (const endpoint of endpoints) {
    await deps.repos.webhookDeliveries.enqueue({
      id: `whd_${randomUUID()}`,
      endpointId: endpoint.id,
      eventType: event.eventType,
      payload,
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
    });
    enqueued += 1;
  }
  return enqueued;
}

export interface WebhookDeliveryResult {
  delivered: number;
  failed: number;
  dead: number;
}

/** Stage 2: claim due deliveries and POST them, signed. */
export async function deliverWebhooks(
  deps: WebhookDispatchDeps,
  limit = 50,
): Promise<WebhookDeliveryResult> {
  const now = deps.clock();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const due = await deps.repos.webhookDeliveries.claimDue(limit, now);
  const result: WebhookDeliveryResult = { delivered: 0, failed: 0, dead: 0 };
  for (const delivery of due) {
    const endpoint = await deps.repos.webhookEndpoints.getById(
      delivery.endpointId,
    );
    if (!endpoint || endpoint.disabledAt) {
      // The receiver is gone; retrying would only ring a removed doorbell.
      await deps.repos.webhookDeliveries.recordFailure(
        delivery.id,
        "endpoint removed",
        now,
        true,
      );
      result.dead += 1;
      continue;
    }
    const body = JSON.stringify({
      eventType: delivery.eventType,
      ...delivery.payload,
    });
    const headers = signWebhook(
      endpoint.secret,
      delivery.id,
      now.getTime() / 1000,
      body,
    );
    try {
      const response = await fetchImpl(endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (response.ok) {
        await deps.repos.webhookDeliveries.markDelivered(delivery.id, now);
        result.delivered += 1;
        continue;
      }
      // Status text only: a hostile receiver's response body must not land
      // in our logs or rows.
      await scheduleRetry(
        deps,
        delivery.id,
        delivery.attempts,
        `status ${response.status}`,
        now,
        result,
      );
    } catch (err) {
      await scheduleRetry(
        deps,
        delivery.id,
        delivery.attempts,
        err instanceof Error ? err.name : "fetch failed",
        now,
        result,
      );
    }
  }
  return result;
}

async function scheduleRetry(
  deps: WebhookDispatchDeps,
  id: string,
  attempts: number,
  error: string,
  now: Date,
  result: WebhookDeliveryResult,
): Promise<void> {
  const dead = attempts >= MAX_DELIVERY_ATTEMPTS;
  const nextAttemptAt = dead
    ? now
    : new Date(now.getTime() + nextAttemptDelayMs(attempts));
  await deps.repos.webhookDeliveries.recordFailure(
    id,
    error,
    nextAttemptAt,
    dead,
  );
  if (dead) {
    result.dead += 1;
    deps.log?.error(
      { deliveryId: id, error },
      "webhook delivery dead-lettered",
    );
  } else {
    result.failed += 1;
  }
}
