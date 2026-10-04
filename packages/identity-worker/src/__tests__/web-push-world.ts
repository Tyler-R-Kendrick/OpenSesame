import { createHash } from "node:crypto";
import type { Repositories } from "@opensesame/database";
import { generateVapidKeyPair } from "@opensesame/notification-adapters";
import {
  type MintedPushSubscription,
  startPushStandIn,
} from "@opensesame/notification-adapters/test-support";
import { runCleanupTick } from "../cleanup.js";
import { MemoryTaskBus } from "../taskBus.js";
import { createWorkerNotificationAdapters } from "../web-push-channel.js";

/**
 * A worker, a person with browsers, and a stand-in push service, over any
 * repositories: the in-memory ones, or a real Postgres.
 */

export const NOW = new Date("2026-10-04T12:00:00.000Z");
export const APPROVER = "prn_approver";
export const AUTH_REQ = "areq_01HZZ-push";
export const SUBJECT = "mailto:ops@example.test";

export const vapid = generateVapidKeyPair();
export const env = (overrides: Record<string, string | undefined> = {}) => ({
  OPENSESAME_WEBPUSH_PUBLIC_KEY: vapid.publicKey,
  OPENSESAME_WEBPUSH_PRIVATE_KEY: vapid.privateKey,
  OPENSESAME_WEBPUSH_SUBJECT: SUBJECT,
  ...overrides,
});

export type World = Awaited<ReturnType<typeof makeWorld>>;

/** What a test may change about the stand-in. */
export interface WorldOptions {
  /** The application server key the push service was told to expect. */
  standInKey?: string;
}

export async function makeWorld(
  repos: Repositories,
  options: WorldOptions = {},
) {
  const service = await startPushStandIn({
    vapidPublicKey: options.standInKey ?? vapid.publicKey,
  });
  // A person to be notified: Postgres holds foreign keys to it.
  await repos.principals.create({
    id: APPROVER,
    state: "active",
    assurance: "provisional",
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  });
  await repos.notificationPreferences.upsert({
    principalId: APPROVER,
    byClass: {
      authorization_request: {
        channels: ["native_push", "in_app"],
        fanOut: false,
      },
    },
    updatedAt: NOW,
    version: 1,
  });
  const clock = { now: NOW };
  const adapters = createWorkerNotificationAdapters({
    repos,
    env: env(),
    fetchImpl: service.fetchImpl,
  });
  const enrol = async (sub: MintedPushSubscription) => {
    await repos.pushSubscriptions.create({
      id: `psub_${sub.id}`,
      principalId: APPROVER,
      endpoint: sub.endpoint,
      p256dhKey: sub.keys.p256dh,
      authSecret: sub.keys.auth,
      endpointDigest: createHash("sha256").update(sub.endpoint).digest("hex"),
      createdAt: NOW,
    });
    return `psub_${sub.id}`;
  };
  const ask = async (id = "obx_1", extra: Record<string, string> = {}) => {
    await repos.outbox.append({
      id,
      aggregateType: "authorization_request",
      aggregateId: AUTH_REQ,
      eventType: "authority.invocation.requested",
      // Due at the tick's clock, never at the wall clock: `append` defaults to
      // `new Date()`, which is after a fixed NOW once the wall clock passes it.
      availableAt: NOW,
      payload: {
        principalId: APPROVER,
        authReqId: AUTH_REQ,
        requestDigest: "sha256:abc",
        bindingMessage: "Transfer funds to account ending 4417",
        ...extra,
      },
    });
  };
  const tick = () =>
    runCleanupTick({
      repos,
      clock: () => clock.now,
      taskBus: new MemoryTaskBus(),
      notificationAdapters: adapters,
    });
  const rows = () => repos.notificationDeliveries.listForRequest(AUTH_REQ);
  return { service, repos, clock, adapters, enrol, ask, tick, rows };
}
