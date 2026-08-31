import type { ClaimEngine } from "@opensesame/claims";
import type { OidcStore, Repositories } from "@opensesame/database";
import type { Logger } from "@opensesame/observability";
import type { Clock, Project, ProvisionalSession } from "@opensesame/os-domain";
import {
  type ChannelAdapterRegistry,
  type NotificationDispatchDeps,
  type NotificationRepos,
  type RoutePlanStore,
  deliverNotifications,
  routeNotification,
} from "./notifications.js";
import { MemoryTaskBus, type TaskBus, outboxToBusEvent } from "./taskBus.js";
import { deliverWebhooks, fanOutWebhooks } from "./webhooks.js";

export interface FakeClock {
  now: Date;
  /** Advance wall clock by ms. */
  advance(ms: number): void;
  /** Clock function for domain engines. */
  asClock(): Clock;
}

export function createFakeClock(start: Date = new Date()): FakeClock {
  let current = start.getTime();
  return {
    get now() {
      return new Date(current);
    },
    set now(value: Date) {
      current = value.getTime();
    },
    advance(ms: number) {
      current += ms;
    },
    asClock() {
      return () => new Date(current);
    },
  };
}

export interface ClaimListStore {
  listIds(): string[];
}

export interface CleanupDeps {
  /** Injected for webhook-delivery tests; the worker passes global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Claim, session and project state to expire.
   *
   * Optional because they live in the control plane's process. A standalone worker
   * has no access to them, and passing empty maps made it report a healthy tick
   * while expiring nothing — a worker that looks like it is enforcing TTLs and is
   * not is worse than one that says it cannot.
   */
  claims?: ClaimEngine;
  claimStore?: ClaimListStore;
  provisionalSessions?: Map<string, ProvisionalSession>;
  projects?: Map<string, Project>;
  /**
   * The issuer's own models — sessions, authorization codes, refresh tokens,
   * device flows, grants. Reads already refuse a row past its TTL, so nothing is
   * honoured late, but until something calls `pruneExpired` the rows stay: a
   * table that only grows, holding authorization state long after it stopped
   * meaning anything. Optional because a deployment without Postgres has no such
   * table.
   */
  oidcStore?: Pick<OidcStore, "pruneExpired">;
  repos: Repositories;
  clock: Clock;
  log?: Logger;
  /**
   * Bus sink for outbox drain. Defaults to in-memory (tests). Production
   * standalone worker injects NATS or memory via `createTaskBusFromEnv`.
   * Publish-then-markPublished keeps the outbox authoritative (ADR 0010).
   */
  taskBus?: TaskBus;
  /**
   * Channel adapters this deployment has configured (ADR 0084). Absent means
   * none: every external step is excluded as `adapter_unavailable` and the
   * plan collapses to the durable inbox, which is exactly what an operator
   * who configured nothing should get.
   */
  notificationAdapters?: ChannelAdapterRegistry;
  /**
   * Where a route plan is remembered between fan-out and delivery, so a
   * fallback can only ever pick a step that plan already contained. Defaults
   * to the router's own bounded store; injected by tests for determinism.
   */
  notificationPlans?: RoutePlanStore;
}

export interface CleanupResult {
  expiredClaims: number;
  expiredSessions: number;
  expiredProjects: number;
  reapedProjects: number;
  outboxPublished: number;
  webhooksEnqueued: number;
  webhooksDelivered: number;
  webhooksDead: number;
  /** Expired issuer rows removed, or undefined when there is no such store. */
  prunedOidcRows?: number;
  /**
   * Notification-router counts, or undefined when the repositories that back
   * it are absent. Undefined means the router did not run — reporting zeros
   * would read as "nobody needed telling", which is a different thing from
   * "nothing was even looked at".
   */
  notificationsEnqueued?: number;
  notificationsDelivered?: number;
  notificationsDead?: number;
  /**
   * Whether this tick had the in-process state needed to expire anything. False
   * means the counts above are zero because nothing was inspected, not because
   * nothing had lapsed.
   */
  expiryEnforced: boolean;
}

/**
 * How long an expired project is kept for inspection before it is dropped.
 * Without a bound the map only ever grows, so a long-lived process accumulates
 * every temporary project it ever issued.
 */
export const EXPIRED_PROJECT_RETENTION_MS = 60 * 60 * 1000;

let outboxDrainTail: Promise<void> = Promise.resolve();

async function withOutboxDrainLock<T>(fn: () => Promise<T>): Promise<T> {
  let release = () => {};
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = outboxDrainTail;
  outboxDrainTail = previous.then(() => turn);
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * The notification router's dependencies, or undefined when this deployment's
 * repositories do not carry the notification tables.
 *
 * Calling a repository that is not there would throw on every tick; counting
 * zero deliveries instead would claim the router is routing while it rings
 * nobody. So the router runs only when its storage is actually present, the
 * legacy webhook fan-out keeps working either way, and `CleanupResult` says
 * which of the two happened.
 */
function notificationDispatch(
  deps: CleanupDeps,
): NotificationDispatchDeps | undefined {
  const available: Partial<NotificationRepos> = deps.repos;
  const { channelBindings, notificationPreferences, notificationDeliveries } =
    available;
  if (!channelBindings || !notificationPreferences || !notificationDeliveries) {
    return undefined;
  }
  return {
    repos: {
      channelBindings,
      notificationPreferences,
      notificationDeliveries,
      webhookEndpoints: deps.repos.webhookEndpoints,
      webhookDeliveries: deps.repos.webhookDeliveries,
    },
    clock: deps.clock,
    ...(deps.notificationAdapters
      ? { adapters: deps.notificationAdapters }
      : undefined),
    ...(deps.notificationPlans ? { plans: deps.notificationPlans } : undefined),
    ...(deps.log ? { log: deps.log } : undefined),
  };
}

/**
 * One cleanup tick: expire claims past TTL, drop provisional sessions/projects,
 * and publish due outbox events to TaskBus before marking them published.
 */
export async function runCleanupTick(
  deps: CleanupDeps,
): Promise<CleanupResult> {
  const now = deps.clock();
  let expiredClaims = 0;
  let expiredSessions = 0;
  let expiredProjects = 0;
  let reapedProjects = 0;
  let outboxPublished = 0;
  const taskBus = deps.taskBus ?? new MemoryTaskBus();

  const claims = deps.claims;
  const claimStore = deps.claimStore;
  const provisionalSessions = deps.provisionalSessions;
  const projects = deps.projects;
  const expiryEnforced =
    claims !== undefined &&
    claimStore !== undefined &&
    provisionalSessions !== undefined &&
    projects !== undefined;

  for (const id of claimStore?.listIds() ?? []) {
    if (!claims) break;
    const session = await claims.get(id);
    if (!session) continue;
    if (
      session.state === "completed" ||
      session.state === "denied" ||
      session.state === "revoked"
    ) {
      continue;
    }
    if (session.state === "expired" || now >= session.expiresAt) {
      try {
        await claims.expire(id);
        expiredClaims += 1;
      } catch {
        // loadFresh may already persist expiry; count if store shows expired
        const after = await claims.get(id);
        if (after?.state === "expired") {
          expiredClaims += 1;
        }
      }
    }
  }

  for (const [id, session] of provisionalSessions ?? []) {
    if (session.expiresAt <= now || session.revokedAt) {
      provisionalSessions?.delete(id);
      expiredSessions += 1;
    }
  }

  for (const [id, project] of projects ?? []) {
    // An activated project expires too: checking only `provisional` left every
    // temporary project that reached `active` alive past its own TTL.
    const live = project.state === "provisional" || project.state === "active";
    if (live && project.expiresAt && project.expiresAt <= now) {
      projects?.set(id, {
        ...project,
        state: "expired",
        updatedAt: now,
      });
      expiredProjects += 1;
      continue;
    }
    if (
      (project.state === "expired" || project.state === "deleted") &&
      now.getTime() - project.updatedAt.getTime() >=
        EXPIRED_PROJECT_RETENTION_MS
    ) {
      projects?.delete(id);
      reapedProjects += 1;
    }
  }

  // Pruning is best-effort: a failure here must not stop the outbox from being
  // published, and the next tick will try again.
  let prunedOidcRows: number | undefined;
  if (deps.oidcStore) {
    try {
      prunedOidcRows = await deps.oidcStore.pruneExpired(now);
    } catch (err) {
      deps.log?.error(
        { err: err instanceof Error ? err.message : String(err) },
        "pruning expired issuer rows failed",
      );
    }
  }

  const pending = await withOutboxDrainLock(() =>
    deps.repos.outbox.claimUnpublished(100, now),
  );
  const notifications = notificationDispatch(deps);
  let webhooksEnqueued = 0;
  let notificationsEnqueued = 0;
  for (const event of pending) {
    try {
      await taskBus.publish(outboxToBusEvent(event));
      // Route the event before it is marked published: a crash between the
      // two re-runs the fan-out next tick, which the delivery table's
      // idempotency key absorbs (and which a webhook receiver absorbs via
      // webhook-id) — a lost doorbell is the failure mode that matters.
      //
      // The router owns the registered-endpoint fan-out too, so the webhook
      // bytes and signatures stay on their one existing code path.
      if (notifications) {
        const routed = await routeNotification(notifications, event);
        webhooksEnqueued += routed.webhooksEnqueued;
        notificationsEnqueued += routed.enqueued;
      } else {
        webhooksEnqueued += await fanOutWebhooks(
          {
            repos: deps.repos,
            clock: deps.clock,
            ...(deps.log ? { log: deps.log } : undefined),
          },
          event,
        );
      }
      await deps.repos.outbox.markPublished(event.id, now);
      outboxPublished += 1;
    } catch (err) {
      await deps.repos.outbox.releaseClaim(
        event.id,
        err instanceof Error ? err.message : String(err),
      );
      // Leave unpublished so the next tick retries (ADR 0010 outbox remains SoT).
      deps.log?.error(
        {
          err: err instanceof Error ? err.message : String(err),
          outboxId: event.id,
          eventType: event.eventType,
        },
        "outbox publish failed; will retry",
      );
    }
  }

  const webhookDelivery = await deliverWebhooks({
    repos: deps.repos,
    clock: deps.clock,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : undefined),
    ...(deps.log ? { log: deps.log } : undefined),
  });

  // Delivery is deliberately outside the drain loop, as the webhook stage
  // already is: a provider that is slow must not hold the outbox open.
  const notificationDelivery = notifications
    ? await deliverNotifications(notifications)
    : undefined;
  const notificationCounts = notificationDelivery
    ? {
        notificationsEnqueued,
        notificationsDelivered: notificationDelivery.delivered,
        notificationsDead: notificationDelivery.dead,
      }
    : undefined;

  deps.log?.info(
    {
      expiredClaims,
      expiredSessions,
      expiredProjects,
      reapedProjects,
      outboxPublished,
      webhooksEnqueued,
      webhooksDelivered: webhookDelivery.delivered,
      webhooksDead: webhookDelivery.dead,
      expiryEnforced,
      ...(prunedOidcRows === undefined ? undefined : { prunedOidcRows }),
      ...notificationCounts,
    },
    "cleanup tick",
  );

  return {
    expiredClaims,
    expiredSessions,
    expiredProjects,
    reapedProjects,
    outboxPublished,
    webhooksEnqueued,
    webhooksDelivered: webhookDelivery.delivered,
    webhooksDead: webhookDelivery.dead,
    expiryEnforced,
    ...(prunedOidcRows === undefined ? undefined : { prunedOidcRows }),
    ...notificationCounts,
  };
}

export interface CleanupLoopOptions extends CleanupDeps {
  intervalMs?: number;
  signal?: AbortSignal;
}

export async function startCleanupLoop(
  options: CleanupLoopOptions,
): Promise<void> {
  const intervalMs = options.intervalMs ?? 5_000;
  while (!options.signal?.aborted) {
    // A throwing tick used to end the loop, which quietly stops expiring claims,
    // sessions, and projects — credentials would then outlive their TTL for as
    // long as the process stayed up. Survive the tick, retry on the next one.
    try {
      await runCleanupTick(options);
    } catch (err) {
      options.log?.error(
        { err: err instanceof Error ? err.message : String(err) },
        "cleanup tick failed; retrying next interval",
      );
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
