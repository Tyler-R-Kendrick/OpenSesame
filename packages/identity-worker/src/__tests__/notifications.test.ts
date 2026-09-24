import {
  ConflictError,
  MemoryRepositories,
  type NotificationDeliveryRepository,
} from "@opensesame/database";
import {
  type ApprovalPolicy,
  type AuthorizationRequest,
  CHANNEL_CAPABILITIES,
  type ChannelCapabilities,
  type ExternalChannelBinding,
  type JsonObject,
  type NotificationChannelKind,
  type NotificationDelivery,
  type NotificationPreference,
  type OutboxEvent,
  defaultApprovalPolicy,
} from "@opensesame/os-domain";
import { generateWebhookSecret } from "@opensesame/webhooks";
import { describe, expect, it } from "vitest";
import { runCleanupTick } from "../cleanup.js";
import {
  type ChannelAdapter,
  type ChannelDeliverInput,
  type ChannelDeliveryOutcome,
  type ChannelRenderInput,
  type ChannelUpdateInput,
  type NotificationDispatchDeps,
  createRoutePlanStore,
  deliverNotifications,
  notificationClassForEvent,
  policyFromOutboxPayload,
  registryFromAdapters,
  retractNotifications,
  routeNotification,
} from "../notifications.js";
import { MemoryTaskBus } from "../taskBus.js";
import {
  MAX_DELIVERY_ATTEMPTS,
  fanOutWebhooks,
  nextAttemptDelayMs,
} from "../webhooks.js";

const NOW = new Date("2026-08-24T12:00:00.000Z");
const APPROVER = "prn_approver";
const AUTH_REQ = "areq_1";

/* ------------------------------------------------------------------ *
 * Stubs
 * ------------------------------------------------------------------ */

interface AdapterStub extends ChannelAdapter {
  readonly rendered: ChannelRenderInput[];
  readonly sent: ChannelDeliverInput[];
  readonly updated: ChannelUpdateInput[];
}

interface AdapterOptions {
  configured?: boolean;
  outcome?: ChannelDeliveryOutcome;
  throwOnDeliver?: boolean;
  throwOnRender?: boolean;
  canUpdate?: boolean;
  throwOnUpdate?: boolean;
}

/**
 * A channel adapter with no network in it. The dispatcher is the thing under
 * test; a real provider client would only make these tests flaky.
 */
function stubAdapter(
  kind: NotificationChannelKind,
  options: AdapterOptions = {},
): AdapterStub {
  const rendered: ChannelRenderInput[] = [];
  const sent: ChannelDeliverInput[] = [];
  const updated: ChannelUpdateInput[] = [];
  const capabilities: ChannelCapabilities = CHANNEL_CAPABILITIES[kind];
  const stub: AdapterStub = {
    kind,
    rendered,
    sent,
    updated,
    isConfigured: () => options.configured !== false,
    capabilities: () => capabilities,
    render: (input) => {
      rendered.push(input);
      if (options.throwOnRender) throw new Error("render exploded");
      // Deliberately confidentiality-aware: `minimal` says something is being
      // asked and nothing about what.
      return input.confidentiality === "minimal"
        ? { eventType: input.eventType, confidentiality: input.confidentiality }
        : {
            eventType: input.eventType,
            confidentiality: input.confidentiality,
            ...input.payload,
          };
    },
    deliver: async (input) => {
      sent.push(input);
      if (options.throwOnDeliver) throw new TypeError("socket hang up");
      return options.outcome ?? { ok: true, providerMessageRef: `ref_${kind}` };
    },
  };
  if (options.canUpdate !== false) {
    stub.update = async (input) => {
      updated.push(input);
      if (options.throwOnUpdate) throw new Error("provider 500: <html>...");
    };
  }
  return stub;
}

function binding(
  kind: NotificationChannelKind,
  overrides: Partial<ExternalChannelBinding> = {},
): ExternalChannelBinding {
  return {
    id: `chb_${kind}`,
    principalId: APPROVER,
    kind,
    providerId: kind,
    providerTenantId: `tenant_${kind}`,
    providerSubjectId: `subject_${kind}`,
    state: "active",
    verification: "provider_oauth_install",
    createdAt: NOW,
    metadata: {},
    version: 1,
    ...overrides,
  };
}

function inboxEvent(payload: JsonObject = {}, id = "obx_1"): OutboxEvent {
  return {
    id,
    aggregateType: "authorization_request",
    aggregateId: AUTH_REQ,
    eventType: "authority.invocation.requested",
    payload: {
      principalId: APPROVER,
      authReqId: AUTH_REQ,
      requestDigest: "sha256:abc",
      ...payload,
    },
    createdAt: NOW,
    availableAt: NOW,
    attempts: 0,
  };
}

interface Harness {
  repos: MemoryRepositories;
  deps: NotificationDispatchDeps;
  clock: { now: Date };
  adapters: Map<NotificationChannelKind, AdapterStub>;
}

interface HarnessOptions {
  adapters?: AdapterStub[];
  preference?: NotificationPreference;
  policy?: ApprovalPolicy;
  bindings?: ExternalChannelBinding[];
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const repos = new MemoryRepositories();
  const clock = { now: NOW };
  const stubs = options.adapters ?? [];
  const adapters = new Map(stubs.map((stub) => [stub.kind, stub]));
  for (const item of options.bindings ?? []) {
    await repos.channelBindings.create(item);
  }
  if (options.preference) {
    await repos.notificationPreferences.upsert({
      principalId: APPROVER,
      byClass: { authorization_request: options.preference },
      updatedAt: NOW,
      version: 1,
    });
  }
  const policy = options.policy;
  const deps: NotificationDispatchDeps = {
    repos,
    clock: () => clock.now,
    adapters: registryFromAdapters(stubs),
    // A store per harness: the fallback ladder must be driven by this test's
    // own plan, never by one another test left behind.
    plans: createRoutePlanStore(),
    ...(policy ? { resolvePolicy: () => policy } : undefined),
  };
  return { repos, deps, clock, adapters };
}

function rowsFor(repos: MemoryRepositories): Promise<NotificationDelivery[]> {
  return repos.notificationDeliveries.listForRequest(AUTH_REQ);
}

/**
 * A delivery ledger that leases what it claims.
 *
 * Postgres gets exclusivity from `FOR UPDATE SKIP LOCKED` inside the claim
 * transaction; the in-memory repository has no row locks to express it with,
 * so two dispatchers sharing one process see the same due set — a property
 * of that fake, not of the dispatcher. This one holds the lease, so the
 * concurrency test measures the dispatcher instead of the store.
 */
function leasedDeliveries(): NotificationDeliveryRepository {
  const rows = new Map<string, NotificationDelivery>();
  const leased = new Set<string>();
  // Exactly the generated column: coalesce(binding_id, endpoint_id, '').
  const destination = (row: NotificationDelivery): string =>
    row.bindingId ?? row.endpointId ?? "";
  return {
    enqueue: async (delivery) => {
      for (const existing of rows.values()) {
        if (
          existing.outboxEventId === delivery.outboxEventId &&
          existing.kind === delivery.kind &&
          destination(existing) === destination(delivery)
        ) {
          throw new ConflictError("notification delivery already fanned out");
        }
      }
      rows.set(delivery.id, { ...delivery });
      return { ...delivery };
    },
    // Everything below the first `await` in a claim must be synchronous, or
    // the second claimant interleaves into the gap the lock exists to close.
    claimDue: async (limit, now) => {
      const claimed: NotificationDelivery[] = [];
      for (const row of rows.values()) {
        if (claimed.length >= limit) break;
        if (leased.has(row.id)) continue;
        if (row.state !== "pending" && row.state !== "failed") continue;
        if (row.nextAttemptAt > now) continue;
        leased.add(row.id);
        const next: NotificationDelivery = {
          ...row,
          attempts: row.attempts + 1,
        };
        rows.set(row.id, next);
        claimed.push({ ...next });
      }
      return claimed;
    },
    markDelivered: async (id, at, providerMessageRef) => {
      const row = rows.get(id);
      if (!row) return;
      rows.set(id, {
        ...row,
        state: "delivered",
        deliveredAt: at,
        ...(providerMessageRef ? { providerMessageRef } : undefined),
      });
      leased.delete(id);
    },
    recordFailure: async (id, error, nextAttemptAt, dead) => {
      const row = rows.get(id);
      if (!row) return;
      rows.set(id, {
        ...row,
        lastError: error,
        nextAttemptAt,
        state: dead ? "dead" : "failed",
      });
      leased.delete(id);
    },
    existsForEvent: async (outboxEventId, kind, destinationId) =>
      [...rows.values()].some(
        (row) =>
          row.outboxEventId === outboxEventId &&
          row.kind === kind &&
          destination(row) === destinationId,
      ),
    listForRequest: async (authReqId) =>
      [...rows.values()]
        .filter((row) => row.authReqId === authReqId)
        .map((row) => ({ ...row })),
  };
}

function pendingRequest(): AuthorizationRequest {
  return {
    id: AUTH_REQ,
    principalId: APPROVER,
    requesterRef: "agt_requester",
    authorizationDetails: [],
    requestDigest: "sha256:abc",
    bindingMessage: "deploy to production",
    status: "pending",
    intervalSeconds: 5,
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 600_000),
    version: 1,
  };
}

/* ------------------------------------------------------------------ *
 * Stage 1 — routing and fan-out
 * ------------------------------------------------------------------ */

describe("notification routing", () => {
  it("contract: routes to the first preferred channel at the step's confidentiality", async () => {
    const slack = stubAdapter("slack");
    const sms = stubAdapter("sms");
    const { repos, deps } = await harness({
      adapters: [slack, sms],
      bindings: [binding("slack"), binding("sms")],
      preference: { channels: ["slack", "sms"], fanOut: false },
      policy: defaultApprovalPolicy("moderate"),
    });

    const result = await routeNotification(deps, inboxEvent());

    expect(result.enqueued).toBe(1);
    const rows = await rowsFor(repos);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("slack");
    expect(rows[0]?.state).toBe("pending");
    // `moderate` caps disclosure at descriptive and Slack's own ceiling is
    // descriptive, so that is what the body was rendered at.
    expect(rows[0]?.confidentiality).toBe("descriptive");
    expect(slack.rendered[0]?.confidentiality).toBe("descriptive");
    // The doorbell never carries the routing key: a destination already knows
    // whose inbox it stands in for.
    expect(JSON.stringify(rows[0]?.payload)).not.toContain(APPROVER);
    expect(JSON.stringify(rows[0]?.payload)).toContain("requestDigest");
    // The inbox is a step in every plan and is never a delivery.
    expect(result.skipped).toContainEqual({
      kind: "in_app",
      reason: "durable_inbox",
    });
    expect(sms.rendered).toHaveLength(0);
  });

  it("property: the policy cap beats the channel's own ceiling", async () => {
    const slack = stubAdapter("slack");
    const { repos, deps } = await harness({
      adapters: [slack],
      bindings: [binding("slack")],
      preference: { channels: ["slack"], fanOut: false },
      // No resolver: the conservative default is `high`, which discloses the
      // minimum even on a channel that could carry more.
    });

    await routeNotification(deps, inboxEvent());

    const rows = await rowsFor(repos);
    expect(rows[0]?.confidentiality).toBe("minimal");
    expect(JSON.stringify(rows[0]?.payload)).not.toContain("requestDigest");
  });

  it("contract: fan-out enqueues every eligible step at once", async () => {
    const slack = stubAdapter("slack");
    const telegram = stubAdapter("telegram");
    const { repos, deps } = await harness({
      adapters: [slack, telegram],
      bindings: [binding("slack"), binding("telegram")],
      preference: { channels: ["slack", "telegram"], fanOut: true },
      policy: defaultApprovalPolicy("moderate"),
    });

    const result = await routeNotification(deps, inboxEvent());

    expect(result.enqueued).toBe(2);
    expect((await rowsFor(repos)).map((row) => row.kind).sort()).toEqual([
      "slack",
      "telegram",
    ]);
  });

  it("security: a re-drained outbox event does not ring the same doorbell twice", async () => {
    const slack = stubAdapter("slack");
    const { repos, deps } = await harness({
      adapters: [slack],
      bindings: [binding("slack")],
      preference: { channels: ["slack"], fanOut: false },
    });

    const first = await routeNotification(deps, inboxEvent());
    // The outbox is at-least-once: the same event arrives again after a crash
    // between fan-out and markPublished.
    const second = await routeNotification(deps, inboxEvent());

    expect(first.enqueued).toBe(1);
    expect(second.enqueued).toBe(0);
    expect(second.skipped).toContainEqual({
      kind: "slack",
      reason: "already_enqueued",
    });
    expect(await rowsFor(repos)).toHaveLength(1);
  });

  it("security: a lost existence check still collides on the unique index", async () => {
    const slack = stubAdapter("slack");
    const { repos, deps } = await harness({
      adapters: [slack],
      bindings: [binding("slack")],
      preference: { channels: ["slack"], fanOut: false },
    });
    await routeNotification(deps, inboxEvent());

    // A replica whose read went to a lagging follower and saw nothing. The
    // insert is the real gate, and its ConflictError means "already fanned
    // out", not "retry me".
    const blind: NotificationDispatchDeps = {
      ...deps,
      repos: {
        ...repos,
        notificationDeliveries: {
          ...repos.notificationDeliveries,
          existsForEvent: async () => false,
        },
      },
    };
    const second = await routeNotification(blind, inboxEvent());

    expect(second.enqueued).toBe(0);
    expect(second.skipped).toContainEqual({
      kind: "slack",
      reason: "already_enqueued",
    });
    expect(await rowsFor(repos)).toHaveLength(1);
  });

  it("security: with zero channels configured nothing is recorded as delivered", async () => {
    const { repos, deps } = await harness({
      preference: { channels: ["slack", "sms"], fanOut: true },
      bindings: [binding("slack")],
    });

    const routed = await routeNotification(deps, inboxEvent());
    const delivered = await deliverNotifications(deps);

    // The request is still in the durable inbox — that is the whole point of
    // the inbox — and no row anywhere claims somebody was told.
    expect(routed.enqueued).toBe(0);
    expect(await rowsFor(repos)).toHaveLength(0);
    expect(delivered).toEqual({
      delivered: 0,
      failed: 0,
      dead: 0,
      skipped: 0,
      fellBack: 0,
    });
  });

  it("security: an expired request is not newly notified as actionable", async () => {
    const slack = stubAdapter("slack");
    const { repos, deps } = await harness({
      adapters: [slack],
      bindings: [binding("slack")],
      preference: { channels: ["slack"], fanOut: false },
    });

    const result = await routeNotification(
      deps,
      inboxEvent({ expiresAt: new Date(NOW.getTime() - 1).toISOString() }),
    );

    expect(result.enqueued).toBe(0);
    expect(await rowsFor(repos)).toHaveLength(0);
  });

  it("property: an event nobody subscribes to routes nowhere", async () => {
    const slack = stubAdapter("slack");
    const { repos, deps } = await harness({
      adapters: [slack],
      bindings: [binding("slack")],
      preference: { channels: ["slack"], fanOut: false },
    });

    const event = { ...inboxEvent(), eventType: "principal.created" };
    expect((await routeNotification(deps, event)).enqueued).toBe(0);
    expect(await rowsFor(repos)).toHaveLength(0);
    expect(notificationClassForEvent("principal.created")).toBeUndefined();
    expect(notificationClassForEvent("breach.password.found")).toBe(
      "security_event",
    );
  });

  it("property: a revoked binding is not a live destination", async () => {
    const slack = stubAdapter("slack");
    const { repos, deps } = await harness({
      adapters: [slack],
      bindings: [binding("slack", { state: "revoked", revokedAt: NOW })],
      preference: { channels: ["slack"], fanOut: false },
    });

    expect((await routeNotification(deps, inboxEvent())).enqueued).toBe(0);
    expect(await rowsFor(repos)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Stage 2 — delivery
 * ------------------------------------------------------------------ */

describe("notification delivery", () => {
  it("contract: a claimed row is delivered through its own adapter", async () => {
    const slack = stubAdapter("slack");
    const { repos, deps } = await harness({
      adapters: [slack],
      bindings: [binding("slack")],
      preference: { channels: ["slack"], fanOut: false },
    });
    await routeNotification(deps, inboxEvent());

    const result = await deliverNotifications(deps);

    expect(result.delivered).toBe(1);
    expect(slack.sent).toHaveLength(1);
    // The adapter is handed the binding it was routed to, not a lookup key.
    expect(slack.sent[0]?.binding?.id).toBe("chb_slack");
    const rows = await rowsFor(repos);
    expect(rows[0]?.state).toBe("delivered");
    expect(rows[0]?.providerMessageRef).toBe("ref_slack");
    // Nothing is left claimable: a second pass must not re-send.
    expect(await deliverNotifications(deps)).toMatchObject({ delivered: 0 });
    expect(slack.sent).toHaveLength(1);
  });

  it("chaos: a failing provider retries with backoff and dead-letters at the cap", async () => {
    const slack = stubAdapter("slack", {
      outcome: { ok: false, retryable: true, error: "status 503" },
    });
    const { repos, deps, clock } = await harness({
      adapters: [slack],
      bindings: [binding("slack")],
      preference: { channels: ["slack"], fanOut: false },
    });
    await routeNotification(deps, inboxEvent());

    for (let attempt = 1; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      const result = await deliverNotifications(deps);
      expect(result).toMatchObject({ delivered: 0, failed: 1, dead: 0 });
      clock.now = new Date(
        clock.now.getTime() + nextAttemptDelayMs(attempt) + 1,
      );
    }
    const final = await deliverNotifications(deps);

    expect(final).toMatchObject({ delivered: 0, failed: 0, dead: 1 });
    expect(slack.sent).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    const rows = await rowsFor(repos);
    expect(rows[0]?.state).toBe("dead");
    // A classified code, never the provider's own words.
    expect(rows[0]?.lastError).toBe("status 503");
    expect(await deliverNotifications(deps)).toMatchObject({ dead: 0 });
  });

  it("security: a thrown provider error is stored as a classification, not a body", async () => {
    const slack = stubAdapter("slack", { throwOnDeliver: true });
    const { repos, deps } = await harness({
      adapters: [slack],
      bindings: [binding("slack")],
      preference: { channels: ["slack"], fanOut: false },
    });
    await routeNotification(deps, inboxEvent());

    await deliverNotifications(deps);

    const rows = await rowsFor(repos);
    expect(rows[0]?.lastError).toBe("TypeError");
    expect(rows[0]?.lastError).not.toContain("socket");
  });

  it("security: an adapter that is no longer configured never fakes a success", async () => {
    const slack = stubAdapter("slack");
    const { repos, deps } = await harness({
      adapters: [slack],
      bindings: [binding("slack")],
      preference: { channels: ["slack"], fanOut: false },
    });
    await routeNotification(deps, inboxEvent());

    // The credentials were removed between fan-out and delivery.
    const stripped: NotificationDispatchDeps = {
      ...deps,
      adapters: registryFromAdapters([]),
    };
    const result = await deliverNotifications(stripped);

    expect(result).toMatchObject({ delivered: 0, dead: 1 });
    expect(slack.sent).toHaveLength(0);
    const rows = await rowsFor(repos);
    expect(rows[0]?.state).toBe("dead");
    expect(rows[0]?.lastError).toBe("adapter unavailable: slack");
  });

  it("security: a binding revoked after fan-out is not delivered to", async () => {
    const slack = stubAdapter("slack");
    const { repos, deps } = await harness({
      adapters: [slack],
      bindings: [binding("slack")],
      preference: { channels: ["slack"], fanOut: false },
    });
    await routeNotification(deps, inboxEvent());
    // Whoever holds that Slack account now is not the approver.
    await repos.channelBindings.updateWithVersion("chb_slack", 1, {
      state: "revoked",
      revokedAt: NOW,
    });

    const result = await deliverNotifications(deps);

    expect(slack.sent).toHaveLength(0);
    expect(result).toMatchObject({ delivered: 0, dead: 1 });
    expect((await rowsFor(repos))[0]?.lastError).toBe("binding not usable");
  });

  it("chaos: a crash between claim and send burns exactly one attempt", async () => {
    const slack = stubAdapter("slack");
    const { repos, deps } = await harness({
      adapters: [slack],
      bindings: [binding("slack")],
      preference: { channels: ["slack"], fanOut: false },
    });
    await routeNotification(deps, inboxEvent());

    // The worker claims, then dies before it can send or record anything.
    const claimed = await repos.notificationDeliveries.claimDue(10, NOW);
    expect(claimed).toHaveLength(1);
    expect((await rowsFor(repos))[0]?.attempts).toBe(1);
    expect(slack.sent).toHaveLength(0);

    // The next process picks it up and burns the second — one per claim, so
    // the ladder cannot be reset by crashing.
    await deliverNotifications(deps);
    expect((await rowsFor(repos))[0]?.attempts).toBe(2);
    expect(slack.sent).toHaveLength(1);
  });

  it("concurrency: two dispatchers split the due set and never double-deliver a row", async () => {
    const stubs = [
      stubAdapter("slack"),
      stubAdapter("telegram"),
      stubAdapter("sms"),
      stubAdapter("native_push"),
    ];
    const { repos, deps } = await harness({
      adapters: stubs,
      bindings: [binding("slack"), binding("telegram"), binding("sms")],
      preference: {
        channels: ["slack", "telegram", "sms", "native_push"],
        fanOut: true,
      },
    });
    const deliveries = leasedDeliveries();
    const leased: NotificationDispatchDeps = {
      ...deps,
      repos: { ...repos, notificationDeliveries: deliveries },
    };
    const routed = await routeNotification(leased, inboxEvent());
    expect(routed.enqueued).toBe(4);

    const [first, second] = await Promise.all([
      deliverNotifications(leased, 2),
      deliverNotifications(leased, 2),
    ]);

    expect(first.delivered).toBe(2);
    expect(second.delivered).toBe(2);
    const sentIds = stubs.flatMap((stub) =>
      stub.sent.map((input) => input.delivery.id),
    );
    expect(sentIds).toHaveLength(4);
    expect(new Set(sentIds).size).toBe(4);
    const rows = await deliveries.listForRequest(AUTH_REQ);
    expect(rows.every((row) => row.state === "delivered")).toBe(true);
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Fallback
 * ------------------------------------------------------------------ */

describe("notification fallback", () => {
  it("contract: a permanently failed step advances to the next rung of its plan", async () => {
    const slack = stubAdapter("slack", {
      outcome: { ok: false, retryable: false, error: "channel_not_found" },
    });
    const sms = stubAdapter("sms");
    const { repos, deps } = await harness({
      adapters: [slack, sms],
      bindings: [binding("slack"), binding("sms")],
      preference: { channels: ["slack", "sms"], fanOut: false },
      policy: defaultApprovalPolicy("moderate"),
    });
    await routeNotification(deps, inboxEvent());

    const result = await deliverNotifications(deps);

    expect(result).toMatchObject({ dead: 1, fellBack: 1 });
    const rows = await rowsFor(repos);
    expect(rows.map((row) => row.kind)).toEqual(["slack", "sms"]);
    // Re-rendered for the rung it landed on: SMS may hold less than Slack,
    // and carrying the Slack body across would have leaked the difference.
    expect(rows[1]?.confidentiality).toBe("minimal");
    expect(sms.rendered[0]?.confidentiality).toBe("minimal");
    expect(JSON.stringify(rows[1]?.payload)).not.toContain("requestDigest");
    expect(await deliverNotifications(deps)).toMatchObject({ delivered: 1 });
  });

  it("security: fallback cannot select a channel policy excluded", async () => {
    const slack = stubAdapter("slack", {
      outcome: { ok: false, retryable: false, error: "channel_not_found" },
    });
    const sms = stubAdapter("sms");
    const { repos, deps } = await harness({
      adapters: [slack, sms],
      bindings: [binding("slack"), binding("sms")],
      // The person would like SMS. The operator never allowed it, and a
      // preference may only ever narrow what policy already permits.
      preference: { channels: ["slack", "sms"], fanOut: false },
      policy: {
        ...defaultApprovalPolicy("moderate"),
        allowedChannels: ["slack", "in_app"],
      },
    });
    const routed = await routeNotification(deps, inboxEvent());
    expect(routed.plan?.excluded).toContainEqual({
      kind: "sms",
      reason: "not_allowed_by_policy",
    });

    const result = await deliverNotifications(deps);

    expect(result).toMatchObject({ dead: 1, fellBack: 0 });
    expect(sms.sent).toHaveLength(0);
    expect((await rowsFor(repos)).map((row) => row.kind)).toEqual(["slack"]);
  });

  it("security: fallback cannot select a channel whose binding is gone", async () => {
    const slack = stubAdapter("slack", {
      outcome: { ok: false, retryable: false, error: "channel_not_found" },
    });
    const telegram = stubAdapter("telegram");
    const { repos, deps } = await harness({
      adapters: [slack, telegram],
      // Telegram is preferred, allowed and configured — and unbound, so it is
      // not a destination at all.
      bindings: [binding("slack")],
      preference: { channels: ["slack", "telegram"], fanOut: false },
      policy: defaultApprovalPolicy("moderate"),
    });
    const routed = await routeNotification(deps, inboxEvent());
    expect(routed.plan?.excluded).toContainEqual({
      kind: "telegram",
      reason: "no_active_binding",
    });

    const result = await deliverNotifications(deps);

    expect(result).toMatchObject({ dead: 1, fellBack: 0 });
    expect(telegram.sent).toHaveLength(0);
    expect((await rowsFor(repos)).map((row) => row.kind)).toEqual(["slack"]);
  });

  it("security: a dispatcher that has forgotten the plan does not invent one", async () => {
    const slack = stubAdapter("slack", {
      outcome: { ok: false, retryable: false, error: "channel_not_found" },
    });
    const sms = stubAdapter("sms");
    const { repos, deps } = await harness({
      adapters: [slack, sms],
      bindings: [binding("slack"), binding("sms")],
      preference: { channels: ["slack", "sms"], fanOut: false },
      policy: defaultApprovalPolicy("moderate"),
    });
    await routeNotification(deps, inboxEvent());

    // A restart, or an eviction from the bounded store. Falling back on a
    // plan we no longer hold would mean re-deriving eligibility from today's
    // policy, so the row simply dies and the inbox keeps the request.
    const forgetful: NotificationDispatchDeps = {
      ...deps,
      plans: createRoutePlanStore(),
    };
    const result = await deliverNotifications(forgetful);

    expect(result).toMatchObject({ dead: 1, fellBack: 0 });
    expect((await rowsFor(repos)).map((row) => row.kind)).toEqual(["slack"]);
  });

  it("property: fan-out never falls back — every bell already rang", async () => {
    const slack = stubAdapter("slack", {
      outcome: { ok: false, retryable: false, error: "channel_not_found" },
    });
    const sms = stubAdapter("sms");
    const { repos, deps } = await harness({
      adapters: [slack, sms],
      bindings: [binding("slack"), binding("sms")],
      preference: { channels: ["slack", "sms"], fanOut: true },
      policy: defaultApprovalPolicy("moderate"),
    });
    await routeNotification(deps, inboxEvent());

    const result = await deliverNotifications(deps);

    expect(result).toMatchObject({ delivered: 1, dead: 1, fellBack: 0 });
    expect(await rowsFor(repos)).toHaveLength(2);
  });

  it("property: a failing ladder enqueues each destination at most once", async () => {
    const slack = stubAdapter("slack", {
      outcome: { ok: false, retryable: false, error: "channel_not_found" },
    });
    const sms = stubAdapter("sms", {
      outcome: { ok: false, retryable: false, error: "carrier_rejected" },
    });
    const { repos, deps } = await harness({
      adapters: [slack, sms],
      bindings: [binding("slack"), binding("sms")],
      preference: { channels: ["slack", "sms"], fanOut: false },
      policy: defaultApprovalPolicy("moderate"),
    });
    await routeNotification(deps, inboxEvent());

    // Slack dies and hands off to SMS; SMS dies and has nowhere to hand off
    // to. The idempotence key is what makes that terminate.
    await deliverNotifications(deps);
    await deliverNotifications(deps);
    await deliverNotifications(deps);

    const rows = await rowsFor(repos);
    expect(rows.map((row) => row.kind)).toEqual(["slack", "sms"]);
    expect(rows.every((row) => row.state === "dead")).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Retraction
 * ------------------------------------------------------------------ */

describe("notification retraction", () => {
  it("contract: a settled request withdraws the messages it can", async () => {
    const slack = stubAdapter("slack");
    const { deps } = await harness({
      adapters: [slack],
      bindings: [binding("slack")],
      preference: { channels: ["slack"], fanOut: false },
    });
    await routeNotification(deps, inboxEvent());
    await deliverNotifications(deps);

    const result = await retractNotifications(deps, AUTH_REQ);

    expect(result).toMatchObject({ updated: 1, failed: 0 });
    expect(slack.updated[0]?.providerMessageRef).toBe("ref_slack");
  });

  it("security: a failed retraction does not change authorization state", async () => {
    const slack = stubAdapter("slack", { throwOnUpdate: true });
    const { repos, deps } = await harness({
      adapters: [slack],
      bindings: [binding("slack")],
      preference: { channels: ["slack"], fanOut: false },
    });
    const request = await repos.authorizationRequests.create(pendingRequest());
    await routeNotification(deps, inboxEvent());
    await deliverNotifications(deps);

    const result = await retractNotifications(deps, AUTH_REQ);

    // An unreachable chat API is not a veto over a decision that was made.
    expect(result).toMatchObject({ updated: 0, failed: 1 });
    const after = await repos.authorizationRequests.getById(AUTH_REQ);
    expect(after?.status).toBe(request.status);
    expect(after?.version).toBe(request.version);
  });

  it("property: a channel that cannot revise a message is reported, not pretended", async () => {
    const sms = stubAdapter("sms", { canUpdate: false });
    const { deps } = await harness({
      adapters: [sms],
      bindings: [binding("sms")],
      preference: { channels: ["sms"], fanOut: false },
    });
    await routeNotification(deps, inboxEvent());
    await deliverNotifications(deps);

    expect(await retractNotifications(deps, AUTH_REQ)).toMatchObject({
      updated: 0,
      unsupported: 1,
    });
  });
});

/* ------------------------------------------------------------------ *
 * The invariant that matters most
 * ------------------------------------------------------------------ */

describe("notification and settlement are separate state machines", () => {
  it("security: the router never touches the authorization request repository", async () => {
    const slack = stubAdapter("slack", {
      outcome: { ok: false, retryable: false, error: "channel_not_found" },
    });
    const sms = stubAdapter("sms");
    const { repos, deps } = await harness({
      adapters: [slack, sms],
      bindings: [binding("slack"), binding("sms")],
      preference: { channels: ["slack", "sms"], fanOut: false },
      policy: defaultApprovalPolicy("moderate"),
    });

    // Every property access is recorded — reaching for `updateWithVersion` at
    // all is the failure, not just calling it.
    const touched: string[] = [];
    const tripwire = new Proxy(
      {},
      {
        get: (_target, property) => {
          touched.push(String(property));
          return () => undefined;
        },
      },
    );
    // `NotificationRepos` has no `authorizationRequests` member at all, which
    // is the compile-time half of this invariant; the tripwire is the runtime
    // half, for anything that reaches around the type.
    const watchedRepos = { ...repos, authorizationRequests: tripwire };
    const watched: NotificationDispatchDeps = { ...deps, repos: watchedRepos };

    await routeNotification(watched, inboxEvent());
    await deliverNotifications(watched);
    await deliverNotifications(watched);
    await retractNotifications(watched, AUTH_REQ);

    expect(touched).toEqual([]);
  });

  it("security: dead-lettering a delivery approves and denies nothing", async () => {
    const slack = stubAdapter("slack", {
      outcome: { ok: false, retryable: true, error: "status 503" },
    });
    const { repos, deps, clock } = await harness({
      adapters: [slack],
      bindings: [binding("slack")],
      preference: { channels: ["slack"], fanOut: false },
    });
    const request = await repos.authorizationRequests.create(pendingRequest());
    await routeNotification(deps, inboxEvent());

    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      await deliverNotifications(deps);
      clock.now = new Date(
        clock.now.getTime() + nextAttemptDelayMs(attempt) + 1,
      );
    }

    expect((await rowsFor(repos))[0]?.state).toBe("dead");
    const after = await repos.authorizationRequests.getById(AUTH_REQ);
    expect(after?.status).toBe("pending");
    expect(after?.version).toBe(request.version);
  });

  it("security: delivering twice does not authorize twice", async () => {
    const slack = stubAdapter("slack");
    const { repos, deps } = await harness({
      adapters: [slack],
      bindings: [binding("slack")],
      preference: { channels: ["slack"], fanOut: false },
    });
    const request = await repos.authorizationRequests.create(pendingRequest());

    await routeNotification(deps, inboxEvent());
    await deliverNotifications(deps);
    // A duplicate drain, then a second delivery pass.
    await routeNotification(deps, inboxEvent());
    await deliverNotifications(deps);

    expect(slack.sent).toHaveLength(1);
    expect(await rowsFor(repos)).toHaveLength(1);
    const after = await repos.authorizationRequests.getById(AUTH_REQ);
    expect(after?.status).toBe("pending");
    expect(after?.version).toBe(request.version);
  });
});

/* ------------------------------------------------------------------ *
 * Compatibility with the Standard Webhooks path
 * ------------------------------------------------------------------ */

describe("registered webhook endpoints", () => {
  it("contract: the router produces the bytes the old fan-out produced", async () => {
    const { repos, deps } = await harness();
    const registered = await repos.webhookEndpoints.create({
      id: "whep_1",
      principalId: APPROVER,
      url: "https://hooks.example.test/inbox",
      secret: generateWebhookSecret(),
      createdAt: NOW,
    });

    const routed = await routeNotification(deps, inboxEvent());

    // A reference run of the path as it existed before the router, on its own
    // store: identical endpoint, identical event, and the payload the
    // receiver signs must be identical too.
    const reference = new MemoryRepositories();
    await reference.webhookEndpoints.create(registered);
    await fanOutWebhooks({ repos: reference, clock: () => NOW }, inboxEvent());

    expect(routed.webhooksEnqueued).toBe(1);
    const [throughRouter] = await repos.webhookDeliveries.claimDue(10, NOW);
    const [throughLegacy] = await reference.webhookDeliveries.claimDue(10, NOW);
    expect(JSON.stringify(throughRouter?.payload)).toBe(
      JSON.stringify(throughLegacy?.payload),
    );
    expect(throughRouter?.eventType).toBe(throughLegacy?.eventType);
    expect(throughRouter?.endpointId).toBe("whep_1");
  });

  it("security: a registered endpoint is rung once, never twice", async () => {
    const webhook = stubAdapter("webhook");
    const { repos, deps } = await harness({
      adapters: [webhook],
      // The person put webhooks on their ladder as well. The endpoint still
      // gets exactly one delivery: two paths to one receiver is a duplicate
      // doorbell, and only one of them carries the signature it verifies.
      preference: { channels: ["webhook"], fanOut: true },
    });
    await repos.webhookEndpoints.create({
      id: "whep_1",
      principalId: APPROVER,
      url: "https://hooks.example.test/inbox",
      secret: generateWebhookSecret(),
      createdAt: NOW,
    });

    const routed = await routeNotification(deps, inboxEvent());

    expect(routed.webhooksEnqueued).toBe(1);
    expect(routed.enqueued).toBe(0);
    expect(routed.skipped).toContainEqual({
      kind: "webhook",
      reason: "delegated_to_webhooks",
    });
    expect(await rowsFor(repos)).toHaveLength(0);
    expect(await repos.webhookDeliveries.claimDue(10, NOW)).toHaveLength(1);
    expect(webhook.sent).toHaveLength(0);
  });

  it("contract: the cleanup tick drains, routes and delivers in one pass", async () => {
    const slack = stubAdapter("slack");
    const { repos, deps } = await harness({
      adapters: [slack],
      bindings: [binding("slack")],
      preference: { channels: ["slack"], fanOut: false },
    });
    const event = inboxEvent();
    await repos.outbox.append({
      id: event.id,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.payload,
      availableAt: NOW,
    });

    const result = await runCleanupTick({
      repos,
      clock: () => NOW,
      taskBus: new MemoryTaskBus(),
      notificationAdapters: registryFromAdapters([slack]),
      ...(deps.plans ? { notificationPlans: deps.plans } : undefined),
    });

    expect(result.outboxPublished).toBe(1);
    expect(result.notificationsEnqueued).toBe(1);
    expect(result.notificationsDelivered).toBe(1);
    expect(result.notificationsDead).toBe(0);
    expect((await rowsFor(repos))[0]?.state).toBe("delivered");
  });
});

/* ------------------------------------------------------------------ *
 * Policy resolution
 * ------------------------------------------------------------------ */

describe("policy from the outbox payload", () => {
  it("contract: an absent policy is the conservative default", () => {
    const policy = policyFromOutboxPayload({});
    expect(policy.riskClass).toBe("high");
    expect(policy.directApprovalChannels).toEqual([]);
    expect(policy.maximumNotificationConfidentiality).toBe("minimal");
  });

  it("contract: the control plane's routing clauses are honoured", () => {
    const policy = policyFromOutboxPayload({
      approvalPolicy: {
        id: "policy:ops:deploy",
        riskClass: "moderate",
        allowedChannels: ["slack", "in_app"],
        maximumNotificationConfidentiality: "descriptive",
      },
    });
    expect(policy.id).toBe("policy:ops:deploy");
    expect(policy.allowedChannels).toEqual(["slack", "in_app"]);
    expect(policy.maximumNotificationConfidentiality).toBe("descriptive");
  });

  it("security: a policy that names an unknown channel is refused whole", () => {
    const policy = policyFromOutboxPayload({
      approvalPolicy: {
        riskClass: "moderate",
        allowedChannels: ["slack", "carrier-pigeon"],
      },
    });
    // Not "slack": dropping the entry we could not read would have invented a
    // narrower policy nobody wrote.
    expect(policy.allowedChannels).toEqual(
      defaultApprovalPolicy("moderate").allowedChannels,
    );
  });

  it("security: direct settlement cannot be widened past what a channel can prove", () => {
    const policy = policyFromOutboxPayload({
      approvalPolicy: {
        riskClass: "moderate",
        allowedChannels: ["sms", "in_app"],
        directApprovalChannels: ["sms"],
      },
    });
    // A phone number is a lease from a carrier. It may ring; it may not decide.
    expect(policy.directApprovalChannels).toEqual([]);
  });
});
