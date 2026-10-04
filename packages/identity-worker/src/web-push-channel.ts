import type {
  PushSubscription,
  PushSubscriptionRepository,
} from "@opensesame/database";
import {
  DELIVERY_TIMEOUT_MS,
  type ChannelAdapter as PackageChannelAdapter,
  type RenderedMessage,
  type WakeAction,
  type WakeSignal,
  createWebPushAdapter,
  loadVapidIdentity,
} from "@opensesame/notification-adapters";
import type { Logger } from "@opensesame/observability";
import {
  type JsonObject,
  NOTIFICATION_CLASSES,
  type NotificationClass,
  readJsonObject,
  readString,
} from "@opensesame/os-domain";
import { DELIVERY_DEADLINE_MS, mapBounded } from "./bounded.js";
import {
  type ChannelAdapter,
  type ChannelAdapterRegistry,
  type ChannelDeliverInput,
  type ChannelDeliveryOutcome,
  type ChannelRenderInput,
  EMPTY_ADAPTER_REGISTRY,
  registryFromAdapters,
} from "./notifications.js";

/**
 * Web Push for the worker (ADR 0084): the bridge between the dispatcher's
 * contract and the package adapter's.
 *
 * The dispatcher hands an adapter `render({eventType, payload, …})` once, to
 * store a row, and `deliver({delivery, now})` later, to send it. The package
 * adapter renders a `RenderedMessage` and delivers it to one
 * `{endpoint, keys}` at a time. Neither knows about the other, and a person
 * has no single destination: they have however many browsers enrolled. This
 * is where those meet.
 *
 * - `render` reduces the outbox payload to the closed vocabulary the Pages
 *   service worker reads (a class, an action label and the request's opaque
 *   reference) and stores that. Nothing the requester wrote is in the row's
 *   push form, and nothing is sent that the row does not hold.
 * - `deliver` lists the principal's live subscriptions and pushes to each.
 *   A subscription the push service says is gone (404, 410), or one that can
 *   never be delivered to (bad keys, a private or non-https endpoint), is
 *   disabled so it is not tried again. A 401/403 is the operator's VAPID
 *   identity being refused, not the subscription's fault, so nothing is
 *   retired for it.
 */

const RETIRING_ERRORS: readonly RegExp[] = [
  /^status:(?:404|410)$/u,
  /^subscription:/u,
  /^insecure_endpoint$/u,
  /^private_endpoint$/u,
];

function retiresSubscription(error: string): boolean {
  return RETIRING_ERRORS.some((pattern) => pattern.test(error));
}

/** Sends to one person's browsers in flight at once (the cap is 10 each). */
export const PUSH_CONCURRENCY = 5;

const WAKE_ACTIONS: readonly WakeAction[] = ["review", "decided", "none"];

/** The row's `wake`, read back through the same closed vocabulary. */
function readWake(payload: JsonObject): WakeSignal | undefined {
  const wake = readJsonObject(payload.wake);
  if (!wake) return undefined;
  const kind = NOTIFICATION_CLASSES.find((c) => c === readString(wake.kind));
  const action = WAKE_ACTIONS.find((a) => a === readString(wake.action));
  if (!kind || !action) return undefined;
  const ref = readString(wake.ref);
  return ref ? { kind, action, ref } : { kind, action };
}

function renderedFrom(payload: JsonObject): RenderedMessage | undefined {
  const wake = readWake(payload);
  if (!wake) return undefined;
  return {
    kind: "native_push",
    confidentiality: "minimal",
    title: readString(payload.title) ?? "",
    body: readString(payload.body) ?? "",
    wake,
  };
}

export interface WebPushChannelDeps {
  /** The package adapter, configured with this deployment's VAPID identity. */
  adapter: PackageChannelAdapter;
  subscriptions: Pick<
    PushSubscriptionRepository,
    "listForPrincipal" | "disable"
  >;
  log?: Logger;
}

/** What one delivery learned from pushing to a person's subscriptions. */
interface Tally {
  delivered: number;
  retryable?: string;
  permanent?: string;
}

/** Push to one subscription and record what came of it. */
async function pushTo(
  deps: WebPushChannelDeps,
  message: RenderedMessage,
  subscription: PushSubscription,
  now: Date,
  tally: Tally,
): Promise<void> {
  const outcome = await deps.adapter.deliver(message, {
    channel: "native_push",
    subscription: {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dhKey, auth: subscription.authSecret },
    },
  });
  if (outcome.status === "delivered") {
    tally.delivered += 1;
    return;
  }
  const error = outcome.error ?? outcome.status;
  if (outcome.status === "retryable") {
    tally.retryable = error;
    return;
  }
  tally.permanent = error;
  if (outcome.status === "permanent" && retiresSubscription(error)) {
    await deps.subscriptions.disable(subscription.id, now);
    // An id and a digest, never the endpoint: it is a capability URL.
    deps.log?.info(
      {
        subscriptionId: subscription.id,
        endpointDigest: subscription.endpointDigest,
        error,
      },
      "web push subscription retired",
    );
  }
}

export function createWebPushChannel(deps: WebPushChannelDeps): ChannelAdapter {
  const render = (input: ChannelRenderInput): JsonObject => {
    const notificationClass: NotificationClass = input.notificationClass;
    const message = deps.adapter.render({
      kind: "native_push",
      confidentiality: input.confidentiality,
      notificationClass,
      eventType: input.eventType,
      rendezvousRef: readString(input.payload.authReqId) ?? "",
    });
    const stored = readJsonObject(JSON.parse(JSON.stringify(message)));
    if (!stored) throw new Error("web push render produced no object");
    return stored;
  };

  const deliver = async (
    input: ChannelDeliverInput,
  ): Promise<ChannelDeliveryOutcome> => {
    const message = renderedFrom(input.delivery.payload);
    if (!message) {
      return { ok: false, retryable: false, error: "not_a_wake_message" };
    }
    const subscriptions = await deps.subscriptions.listForPrincipal(
      input.delivery.principalId,
    );
    if (subscriptions.length === 0) {
      // Nobody to ring. Permanent, so the ladder moves on to the next rung
      // (the inbox, at the last) instead of retrying a person with no phone.
      return { ok: false, retryable: false, error: "no_subscription" };
    }
    const tally: Tally = { delivered: 0 };
    // A person's browsers are pushed to side by side, and no new send starts
    // once there is no longer time for it to finish inside the row's deadline
    // (each send carries its own transport timeout). A subscription that never
    // answers costs this row one timeout, not one timeout per subscription.
    const startBy = Date.now() + DELIVERY_DEADLINE_MS - DELIVERY_TIMEOUT_MS;
    const pass = {
      concurrency: PUSH_CONCURRENCY,
      perKey: PUSH_CONCURRENCY,
      keyOf: () => "push",
    };
    await mapBounded(subscriptions, pass, async (subscription) => {
      if (Date.now() > startBy) {
        tally.retryable ??= "deadline_exceeded";
        return;
      }
      await pushTo(deps, message, subscription, input.now, tally);
    });
    // One device that got it is delivered. Retrying the row for another that
    // did not would ring the first again; the inbox still holds the request.
    if (tally.delivered > 0) return { ok: true };
    if (tally.retryable) {
      return { ok: false, retryable: true, error: tally.retryable };
    }
    return {
      ok: false,
      retryable: false,
      error: tally.permanent ?? "no_subscription",
    };
  };

  return {
    kind: "native_push",
    isConfigured: () => deps.adapter.isConfigured(),
    capabilities: () => deps.adapter.capabilities(),
    render,
    deliver,
  };
}

export interface WorkerAdapterDeps {
  repos: { pushSubscriptions: WebPushChannelDeps["subscriptions"] };
  log?: Logger;
  env?: Readonly<Record<string, string | undefined>>;
  /** The push service transport; tests inject one, production uses the pinned public-only POST. */
  fetchImpl?: typeof fetch;
}

/**
 * The adapters this worker has, from its environment: Web Push when a VAPID
 * identity is configured, otherwise none, which leaves every plan to collapse
 * to the durable inbox and `native_push` honestly unavailable. A private key
 * that is present but unusable throws (`WebPushConfigError`), so the worker
 * refuses to start rather than run with a channel that cannot send.
 */
export function createWorkerNotificationAdapters(
  deps: WorkerAdapterDeps,
): ChannelAdapterRegistry {
  const identity = loadVapidIdentity(deps.env ?? process.env);
  if (!identity) return EMPTY_ADAPTER_REGISTRY;
  const adapter = createWebPushAdapter({
    ...identity,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : undefined),
  });
  return registryFromAdapters([
    createWebPushChannel({
      adapter,
      subscriptions: deps.repos.pushSubscriptions,
      ...(deps.log ? { log: deps.log } : undefined),
    }),
  ]);
}
