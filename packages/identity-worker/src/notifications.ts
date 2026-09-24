import { randomUUID } from "node:crypto";
import {
  type ChannelBindingRepository,
  ConflictError,
  type NotificationDeliveryRepository,
  type NotificationPreferenceRepository,
  type WebhookDeliveryRepository,
  type WebhookEndpointRepository,
} from "@opensesame/database";
import type { Logger } from "@opensesame/observability";
import {
  type ApprovalPolicy,
  type ApprovalRiskClass,
  type ChannelCapabilities,
  type ChannelRouteStep,
  DEFAULT_NOTIFICATION_PREFERENCE,
  type ExternalChannelBinding,
  type JsonObject,
  type JsonValue,
  NOTIFICATION_CHANNEL_KINDS,
  type NotificationChannelKind,
  type NotificationClass,
  type NotificationConfidentiality,
  type NotificationDelivery,
  type NotificationPreference,
  type OutboxEvent,
  type RoutePlan,
  defaultApprovalPolicy,
  isBindingUsable,
  normalizeApprovalPolicy,
  planNotificationRoute,
  readJsonObject,
  readString,
} from "@opensesame/os-domain";
import {
  MAX_DELIVERY_ATTEMPTS,
  fanOutWebhooks,
  nextAttemptDelayMs,
} from "./webhooks.js";

/**
 * Notification routing for the authorization-request inbox (ADR 0084).
 *
 * This is `webhooks.ts` generalized, not replaced: the same two stages, the
 * same durable outbox as the source of truth, the same backoff ladder — but
 * the destination is now whatever `planNotificationRoute` says it is, and
 * registered Standard Webhooks endpoints keep their own byte-identical path
 * (see "Compatibility" below).
 *
 * 1. **Route + fan out** — an outbox event becomes at most one
 *    `notification_deliveries` row per destination the plan names. The plan
 *    is `policy ∩ preference ∩ live bindings ∩ configured adapters`, computed
 *    once, in the domain, so no code path here can widen it.
 * 2. **Deliver** — due rows are claimed (attempts counted on claim, so a
 *    crash mid-send still burned a try), handed to their channel's adapter,
 *    and either marked delivered or rescheduled. After the cap the row is
 *    dead-lettered.
 *
 * Three properties are worth stating outright, because each of them is a
 * security boundary rather than a nicety:
 *
 * - **Notification and settlement are separate state machines.** Nothing in
 *   this file may approve, deny, or otherwise move an authorization request,
 *   and `NotificationRepos` deliberately has no `authorizationRequests`
 *   member so that a future edit cannot quietly acquire the ability. A
 *   dead-lettered delivery has denied nothing; a delivery sent twice has
 *   authorized nothing.
 * - **The outbox is at-least-once, so fan-out is idempotent.** Every enqueue
 *   is gated on `existsForEvent(outboxEventId, kind, destinationId)` and a
 *   `ConflictError` from the insert is read as "already fanned out". A
 *   retried drain must not ring the same doorbell twice — a person who is
 *   paged three times for one request learns to ignore the page.
 * - **Never a payload richer than the step allows.** The body is rendered by
 *   the adapter at the *step's* confidentiality, which the domain already
 *   narrowed to the weaker of the channel's ceiling and the policy's. A lock
 *   screen, an archived Slack workspace and a compliance export are all
 *   "the notification".
 *
 * **Compatibility.** Registered webhook endpoints are still served by
 * `webhooks.ts`, delegated to from stage 1, so their bytes and signatures
 * cannot drift. That fan-out is deliberately *not* gated on the preference
 * ladder: an endpoint registration is an explicit per-endpoint opt-in the
 * approver already made through the endpoint API, and the ladder governs
 * where a *person* is interrupted, not whether a program they registered
 * keeps receiving its doorbell. Silently unsubscribing live integrations
 * because a preferences row now exists would be a regression dressed as a
 * feature.
 */

/* ------------------------------------------------------------------ *
 * Adapters
 * ------------------------------------------------------------------ */

/**
 * The adapter contract, declared structurally.
 *
 * `@opensesame/notification-adapters` owns the real definition; this is the
 * subset the dispatcher actually calls, so the two converge by structural
 * assignability rather than by an import that would couple the worker's
 * build to a package it does not own. `verifyCallback` is deliberately
 * absent: verifying an inbound provider callback is settlement, and
 * settlement does not happen in this file.
 */
export interface ChannelAdapter {
  readonly kind: NotificationChannelKind;
  /** Does this deployment actually hold the credentials this channel needs? */
  isConfigured(): boolean;
  capabilities(): ChannelCapabilities;
  /** Body reduced to `input.confidentiality`. Never richer. */
  render(input: ChannelRenderInput): JsonObject | Promise<JsonObject>;
  deliver(input: ChannelDeliverInput): Promise<ChannelDeliveryOutcome>;
  /** Revise or withdraw a message we already sent, where the channel can. */
  update?(input: ChannelUpdateInput): Promise<void>;
}

export interface ChannelRenderInput {
  eventType: string;
  notificationClass: NotificationClass;
  confidentiality: NotificationConfidentiality;
  /** The outbox payload with the routing key removed. */
  payload: JsonObject;
  binding?: ExternalChannelBinding;
}

export interface ChannelDeliverInput {
  delivery: NotificationDelivery;
  binding?: ExternalChannelBinding;
  now: Date;
}

export interface ChannelUpdateInput {
  delivery: NotificationDelivery;
  providerMessageRef: string;
  binding?: ExternalChannelBinding;
  now: Date;
}

/**
 * The result of one send.
 *
 * `error` is a classification the adapter chose — `status 503`, `timeout`,
 * `unauthorized`. A provider's response body never appears here, in a log,
 * or in a stored row: a hostile receiver must not get to write our audit
 * trail, and a helpful one should not get to leak its tenant's data into it.
 */
export type ChannelDeliveryOutcome =
  | { ok: true; providerMessageRef?: string }
  | { ok: false; retryable: boolean; error: string };

export interface ChannelAdapterRegistry {
  /** Kinds whose adapter is configured on this deployment. */
  availableChannels(): readonly NotificationChannelKind[];
  get(kind: NotificationChannelKind): ChannelAdapter | undefined;
}

/** A deployment with nothing configured. Every plan collapses to the inbox. */
export const EMPTY_ADAPTER_REGISTRY: ChannelAdapterRegistry = {
  availableChannels: () => [],
  get: () => undefined,
};

/**
 * Registry over a list of adapters.
 *
 * Exported so wiring against `createAdapterRegistry` stays a one-liner even
 * if that package's own lookup method ends up named something else.
 */
export function registryFromAdapters(
  adapters: readonly ChannelAdapter[],
): ChannelAdapterRegistry {
  const byKind = new Map<NotificationChannelKind, ChannelAdapter>();
  for (const adapter of adapters) byKind.set(adapter.kind, adapter);
  return {
    availableChannels: () =>
      [...byKind.values()]
        .filter((adapter) => adapter.isConfigured())
        .map((adapter) => adapter.kind),
    get: (kind) => byKind.get(kind),
  };
}

/* ------------------------------------------------------------------ *
 * Dependencies
 * ------------------------------------------------------------------ */

/**
 * Exactly the repositories this dispatcher may touch.
 *
 * The omission is the point: `authorizationRequests` is not here, so no edit
 * to this file can approve, deny, or otherwise move a request without first
 * widening this type — which a reviewer will see.
 */
export interface NotificationRepos {
  channelBindings: Pick<
    ChannelBindingRepository,
    "listForPrincipal" | "getById"
  >;
  notificationPreferences: Pick<NotificationPreferenceRepository, "get">;
  notificationDeliveries: NotificationDeliveryRepository;
  webhookEndpoints: WebhookEndpointRepository;
  webhookDeliveries: WebhookDeliveryRepository;
}

export interface NotificationDispatchDeps {
  repos: NotificationRepos;
  clock: () => Date;
  /** Absent means nothing but the inbox is configured. */
  adapters?: ChannelAdapterRegistry;
  /** Where fallback reads the plan that authorized it. See `RoutePlanStore`. */
  plans?: RoutePlanStore;
  /**
   * Effective policy for an event. Defaults to the payload-derived policy,
   * which itself falls back to `defaultApprovalPolicy("high")`.
   */
  resolvePolicy?: (
    event: OutboxEvent,
    notificationClass: NotificationClass,
  ) => ApprovalPolicy | Promise<ApprovalPolicy>;
  /** Injected for deterministic tests. */
  newId?: () => string;
  /** The legacy Standard Webhooks fan-out. Injected only by tests. */
  fanOutWebhookEndpoints?: typeof fanOutWebhooks;
  log?: Logger;
}

/* ------------------------------------------------------------------ *
 * Event classification
 * ------------------------------------------------------------------ */

export const NOTIFICATION_EVENT_CLASSES = {
  "authority.invocation.requested": "authorization_request",
  "authority.invocation.completed": "authorization_decision",
} as const satisfies { readonly [eventType: string]: NotificationClass };

/**
 * An equality walk rather than an index: an event type is a string that came
 * off the wire, and indexing a plain object with one answers `"constructor"`
 * and friends with something that is not a notification class.
 */
function directClassFor(eventType: string): NotificationClass | undefined {
  for (const [known, cls] of Object.entries(NOTIFICATION_EVENT_CLASSES)) {
    if (known === eventType) return cls;
  }
  return undefined;
}

const SECURITY_EVENT_PREFIXES = ["security.", "breach.", "lifecycle."] as const;

/**
 * Which preference bucket an event falls in, or `undefined` for the events
 * that are nobody's business to be interrupted by. Unknown types route
 * nowhere rather than defaulting into somebody's phone.
 */
export function notificationClassForEvent(
  eventType: string,
): NotificationClass | undefined {
  const direct = directClassFor(eventType);
  if (direct) return direct;
  return SECURITY_EVENT_PREFIXES.some((prefix) => eventType.startsWith(prefix))
    ? "security_event"
    : undefined;
}

/**
 * `webhook` is served by `webhooks.ts` and must not also get a row here —
 * two paths to the same endpoint is a duplicate doorbell, and only one of
 * them produces the signature receivers already verify.
 */
const DELEGATED_CHANNELS: ReadonlySet<NotificationChannelKind> = new Set([
  "webhook",
]);

/**
 * The inbox is not a delivery destination: the request is already durably in
 * it, which is the whole reason every other step exists. Enqueuing a row for
 * it would either invite a dispatcher to "send" it or read, later, as a
 * delivery that never happened.
 */
function isDeliverableStep(step: ChannelRouteStep): boolean {
  return step.kind !== "in_app" && !DELEGATED_CHANNELS.has(step.kind);
}

/* ------------------------------------------------------------------ *
 * Policy
 * ------------------------------------------------------------------ */

const RISK_CLASSES: readonly ApprovalRiskClass[] = [
  "low",
  "moderate",
  "high",
  "critical",
];

const CONFIDENTIALITIES: readonly NotificationConfidentiality[] = [
  "minimal",
  "descriptive",
  "full",
];

function readRiskClass(
  value: JsonValue | undefined,
): ApprovalRiskClass | undefined {
  const name = readString(value);
  return RISK_CLASSES.find((risk) => risk === name);
}

function readConfidentiality(
  value: JsonValue | undefined,
): NotificationConfidentiality | undefined {
  const name = readString(value);
  return CONFIDENTIALITIES.find((level) => level === name);
}

/**
 * A channel list, or `undefined` if any entry is not a channel we know.
 *
 * All-or-nothing on purpose: dropping the unreadable entries would turn a
 * policy we do not understand into a narrower one we invented, and the
 * caller would never learn the difference.
 */
function readChannelKinds(
  value: JsonValue | undefined,
): NotificationChannelKind[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kinds: NotificationChannelKind[] = [];
  for (const entry of value) {
    const name = readString(entry);
    const kind = NOTIFICATION_CHANNEL_KINDS.find((known) => known === name);
    if (!kind) return undefined;
    kinds.push(kind);
  }
  return kinds;
}

/**
 * The effective policy for an event, from the outbox payload.
 *
 * There is no policy resolver to import yet, so the control plane's own
 * words — if it put any in the payload — are the best available answer, and
 * `defaultApprovalPolicy("high")` is the answer when it did not: notify
 * wherever the person chose, settle nowhere, disclose the minimum.
 *
 * Only the *routing* clauses are read. `requiredAssurance`,
 * `requireTransactionBoundActivation` and `requireComparison` gate
 * settlement, this module never settles anything, and a policy field parsed
 * where it is not used is a field that will eventually be trusted where it
 * is. Everything goes through `normalizeApprovalPolicy`, so a payload cannot
 * name a direct-approval channel that is not even allowed to be notified.
 */
export function policyFromOutboxPayload(payload: JsonObject): ApprovalPolicy {
  const raw = readJsonObject(payload.approvalPolicy);
  const riskClass =
    readRiskClass(raw?.riskClass) ?? readRiskClass(payload.riskClass) ?? "high";
  const base = defaultApprovalPolicy(riskClass);
  if (!raw) return base;
  const id = readString(raw.id);
  const allowedChannels = readChannelKinds(raw.allowedChannels);
  const directApprovalChannels = readChannelKinds(raw.directApprovalChannels);
  const directDenialChannels = readChannelKinds(raw.directDenialChannels);
  const maximumNotificationConfidentiality = readConfidentiality(
    raw.maximumNotificationConfidentiality,
  );
  return normalizeApprovalPolicy({
    ...base,
    ...(id ? { id } : undefined),
    ...(allowedChannels ? { allowedChannels } : undefined),
    ...(directApprovalChannels ? { directApprovalChannels } : undefined),
    ...(directDenialChannels ? { directDenialChannels } : undefined),
    ...(maximumNotificationConfidentiality
      ? { maximumNotificationConfidentiality }
      : undefined),
  });
}

/* ------------------------------------------------------------------ *
 * Route plans
 * ------------------------------------------------------------------ */

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

const sharedPlanStore = createRoutePlanStore();

/* ------------------------------------------------------------------ *
 * Stage 1: route and fan out
 * ------------------------------------------------------------------ */

export type NotificationSkipReason =
  | "durable_inbox"
  | "delegated_to_webhooks"
  | "adapter_unavailable"
  | "binding_unusable"
  | "already_enqueued"
  | "render_failed"
  /** Eligible, but a later rung of a ladder whose earlier rung rang. */
  | "later_rung";

export interface RouteResult {
  /** Rows enqueued by this call. */
  enqueued: number;
  /** Deliveries the legacy Standard Webhooks path enqueued. */
  webhooksEnqueued: number;
  /** Steps that produced no row, and why. Never a phantom success. */
  skipped: { kind: NotificationChannelKind; reason: NotificationSkipReason }[];
  /** The plan, when one was computed. Absent for events we do not route. */
  plan?: RoutePlan;
}

function emptyRouteResult(webhooksEnqueued: number): RouteResult {
  return { enqueued: 0, webhooksEnqueued, skipped: [] };
}

/**
 * A request nobody can still act on must not be announced as if they could.
 *
 * Only the actionable class is checked: a decision or a security notice has
 * no deadline to be past, and suppressing those would lose the notification
 * that explains why the first one went quiet.
 */
function isPastDeadline(
  payload: JsonObject,
  notificationClass: NotificationClass,
  now: Date,
): boolean {
  if (notificationClass !== "authorization_request") return false;
  const raw = readString(payload.expiresAt);
  if (!raw) return false;
  const deadline = Date.parse(raw);
  return !Number.isNaN(deadline) && deadline <= now.getTime();
}

/**
 * Stage 1: turn one outbox event into the deliveries its route plan names.
 *
 * Safe to call for any event — a type nobody subscribes to routes nowhere.
 */
export async function routeNotification(
  deps: NotificationDispatchDeps,
  event: OutboxEvent,
): Promise<RouteResult> {
  // Registered endpoints first, and unconditionally: this is the byte-for-byte
  // path that already exists, and it is what keeps live integrations working
  // across this change.
  const fanOutEndpoints = deps.fanOutWebhookEndpoints ?? fanOutWebhooks;
  const webhooksEnqueued = await fanOutEndpoints(
    {
      repos: deps.repos,
      clock: deps.clock,
      ...(deps.log ? { log: deps.log } : undefined),
    },
    event,
  );

  const notificationClass = notificationClassForEvent(event.eventType);
  if (!notificationClass) return emptyRouteResult(webhooksEnqueued);
  const principalId = readString(event.payload.principalId);
  if (!principalId) return emptyRouteResult(webhooksEnqueued);

  const now = deps.clock();
  if (isPastDeadline(event.payload, notificationClass, now)) {
    deps.log?.warn(
      { outboxId: event.id, eventType: event.eventType },
      "notification suppressed: request already past its deadline",
    );
    return emptyRouteResult(webhooksEnqueued);
  }

  const registry = deps.adapters ?? EMPTY_ADAPTER_REGISTRY;
  const stored = await deps.repos.notificationPreferences.get(principalId);
  // A person with no stored row is not a person with no preference: the
  // documented default is the durable inbox and nothing else.
  const preference: NotificationPreference =
    stored?.byClass[notificationClass] ?? DEFAULT_NOTIFICATION_PREFERENCE;
  const bindings =
    await deps.repos.channelBindings.listForPrincipal(principalId);
  const resolve = deps.resolvePolicy ?? defaultPolicyResolver;
  const policy = await resolve(event, notificationClass);

  const plan = planNotificationRoute({
    policy,
    preference,
    bindings,
    availableChannels: registry.availableChannels(),
    now,
  });

  // The routing key is dropped before anything renders: a destination
  // already knows whose inbox it is standing in for, and the principal id is
  // the one field on this payload that is pure correlation.
  const { principalId: _routing, ...body } = event.payload;
  const authReqId = readString(event.payload.authReqId);
  const record: RoutePlanRecord = {
    plan,
    notificationClass,
    eventType: event.eventType,
    principalId,
    body,
    ...(authReqId ? { authReqId } : undefined),
  };
  (deps.plans ?? sharedPlanStore).remember(event.id, record);

  const result: RouteResult = {
    enqueued: 0,
    webhooksEnqueued,
    skipped: [],
    plan,
  };
  // Without fan-out one rung of the ladder rings at a time; stage 2 advances
  // it only when that rung permanently fails. The loop still walks the rest
  // of the plan afterwards, because a caller reading `skipped` deserves the
  // whole account of where this event did and did not go.
  let ladderRang = false;
  for (const step of plan.steps) {
    if (step.kind === "in_app") {
      result.skipped.push({ kind: step.kind, reason: "durable_inbox" });
      continue;
    }
    if (DELEGATED_CHANNELS.has(step.kind)) {
      result.skipped.push({ kind: step.kind, reason: "delegated_to_webhooks" });
      continue;
    }
    if (ladderRang && !plan.fanOut) {
      result.skipped.push({ kind: step.kind, reason: "later_rung" });
      continue;
    }
    const outcome = await enqueueStep(deps, record, step, event.id, now);
    if (outcome === "enqueued") {
      result.enqueued += 1;
      ladderRang = true;
      continue;
    }
    result.skipped.push({ kind: step.kind, reason: outcome });
    // A retried drain that finds its own earlier row has already rung this
    // rung; walking on would ring the second bell for a first bell that rang.
    if (outcome === "already_enqueued") ladderRang = true;
  }
  return result;
}

function defaultPolicyResolver(event: OutboxEvent): ApprovalPolicy {
  return policyFromOutboxPayload(event.payload);
}

type EnqueueOutcome =
  | "enqueued"
  | "already_enqueued"
  | "adapter_unavailable"
  | "binding_unusable"
  | "render_failed";

/**
 * The destination half of the idempotence key.
 *
 * It must be spelled exactly as the storage layer derives it — the column is
 * `coalesce(binding_id, endpoint_id, '')` and the unique index is over
 * `(outbox_event_id, kind, destination_id)`. A router that keyed its
 * `existsForEvent` probe differently would ask a question the index cannot
 * answer, miss its own earlier row, and fan the same event out twice.
 * Endpoint-routed rows belong to `webhooks.ts`, so only the binding and the
 * empty string arise here.
 */
function destinationIdFor(step: ChannelRouteStep): string {
  return step.bindingId ?? "";
}

/**
 * Enqueue one step's row. The single enqueue path — fan-out and fallback
 * both come through here, so the eligibility checks cannot drift apart.
 */
async function enqueueStep(
  deps: NotificationDispatchDeps,
  record: RoutePlanRecord,
  step: ChannelRouteStep,
  outboxEventId: string,
  now: Date,
): Promise<EnqueueOutcome> {
  const registry = deps.adapters ?? EMPTY_ADAPTER_REGISTRY;
  const adapter = registry.get(step.kind);
  if (!adapter || !adapter.isConfigured()) return "adapter_unavailable";

  const destinationId = destinationIdFor(step);
  if (
    await deps.repos.notificationDeliveries.existsForEvent(
      outboxEventId,
      step.kind,
      destinationId,
    )
  ) {
    return "already_enqueued";
  }

  const binding = step.bindingId
    ? await deps.repos.channelBindings.getById(step.bindingId)
    : null;
  // The plan saw a live binding; between then and now it may have been
  // revoked. Delivering to a revoked destination is delivering to whoever
  // took it over.
  if (step.bindingId && (!binding || !isBindingUsable(binding, now))) {
    return "binding_unusable";
  }

  let payload: JsonObject;
  try {
    payload = await adapter.render({
      eventType: record.eventType,
      notificationClass: record.notificationClass,
      confidentiality: step.confidentiality,
      payload: record.body,
      ...(binding ? { binding } : undefined),
    });
  } catch (err) {
    // Classified name only: a render that threw with a provider's words in
    // the message must not write them into our log.
    deps.log?.error(
      {
        kind: step.kind,
        error: err instanceof Error ? err.name : "render failed",
      },
      "notification render failed; step skipped",
    );
    return "render_failed";
  }

  const newId = deps.newId ?? (() => `ndl_${randomUUID()}`);
  const delivery: NotificationDelivery = {
    id: newId(),
    principalId: record.principalId,
    kind: step.kind,
    ...(step.bindingId ? { bindingId: step.bindingId } : undefined),
    notificationClass: record.notificationClass,
    eventType: record.eventType,
    outboxEventId,
    ...(record.authReqId ? { authReqId: record.authReqId } : undefined),
    payload,
    confidentiality: step.confidentiality,
    state: "pending",
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
  };
  try {
    await deps.repos.notificationDeliveries.enqueue(delivery);
  } catch (err) {
    // A unique-key collision means another drain already fanned this event
    // out. That is the idempotency working, not an error to retry. The name
    // check covers a repository whose ConflictError crossed a module
    // boundary that `instanceof` cannot see through.
    if (
      err instanceof ConflictError ||
      (err instanceof Error && err.name === "ConflictError")
    ) {
      return "already_enqueued";
    }
    throw err;
  }
  return "enqueued";
}

/* ------------------------------------------------------------------ *
 * Stage 2: deliver
 * ------------------------------------------------------------------ */

export interface NotificationDeliveryResult {
  delivered: number;
  failed: number;
  dead: number;
  /** Rows that were never sendable — an unconfigured adapter, a dead binding. */
  skipped: number;
  /** Ladder rungs advanced after a permanent failure. */
  fellBack: number;
}

const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "delivered",
  "dead",
  "skipped",
]);

/** Stage 2: claim due deliveries and hand them to their adapters. */
export async function deliverNotifications(
  deps: NotificationDispatchDeps,
  limit = 50,
): Promise<NotificationDeliveryResult> {
  const now = deps.clock();
  const registry = deps.adapters ?? EMPTY_ADAPTER_REGISTRY;
  const due = await deps.repos.notificationDeliveries.claimDue(limit, now);
  const result: NotificationDeliveryResult = {
    delivered: 0,
    failed: 0,
    dead: 0,
    skipped: 0,
    fellBack: 0,
  };

  for (const delivery of due) {
    if (TERMINAL_STATES.has(delivery.state)) {
      // A settled row handed back by `claimDue` is a repository bug. Say so
      // and leave it alone: rewriting a terminal row would erase the record
      // of what actually happened to it.
      deps.log?.warn(
        { deliveryId: delivery.id, state: delivery.state },
        "claimDue returned a settled delivery; skipped",
      );
      result.skipped += 1;
      continue;
    }

    const adapter = registry.get(delivery.kind);
    if (!adapter || !adapter.isConfigured()) {
      // Never a fake success. The channel was configured when the row was
      // enqueued and is not now; the row ends, and the ladder advances.
      await settlePermanently(
        deps,
        delivery,
        `adapter unavailable: ${delivery.kind}`,
        now,
        result,
      );
      continue;
    }

    const binding = delivery.bindingId
      ? await deps.repos.channelBindings.getById(delivery.bindingId)
      : null;
    if (delivery.bindingId && (!binding || !isBindingUsable(binding, now))) {
      await settlePermanently(
        deps,
        delivery,
        "binding not usable",
        now,
        result,
      );
      continue;
    }

    try {
      const outcome = await adapter.deliver({
        delivery,
        ...(binding ? { binding } : undefined),
        now,
      });
      if (outcome.ok) {
        if (outcome.providerMessageRef) {
          await deps.repos.notificationDeliveries.markDelivered(
            delivery.id,
            now,
            outcome.providerMessageRef,
          );
        } else {
          await deps.repos.notificationDeliveries.markDelivered(
            delivery.id,
            now,
          );
        }
        result.delivered += 1;
        continue;
      }
      if (!outcome.retryable) {
        await settlePermanently(deps, delivery, outcome.error, now, result);
        continue;
      }
      await scheduleRetry(deps, delivery, outcome.error, now, result);
    } catch (err) {
      // Error name only, exactly as the webhook dispatcher does it: a thrown
      // error's `message` is the likeliest place for a provider's response
      // body to be hiding, and it must not reach a log or a stored row.
      await scheduleRetry(
        deps,
        delivery,
        err instanceof Error ? err.name : "deliver failed",
        now,
        result,
      );
    }
  }
  return result;
}

async function settlePermanently(
  deps: NotificationDispatchDeps,
  delivery: NotificationDelivery,
  error: string,
  now: Date,
  result: NotificationDeliveryResult,
): Promise<void> {
  await deps.repos.notificationDeliveries.recordFailure(
    delivery.id,
    error,
    now,
    true,
  );
  result.dead += 1;
  deps.log?.error(
    { deliveryId: delivery.id, kind: delivery.kind, error },
    "notification delivery dead-lettered",
  );
  if (await enqueueFallback(deps, delivery, now)) result.fellBack += 1;
}

async function scheduleRetry(
  deps: NotificationDispatchDeps,
  delivery: NotificationDelivery,
  error: string,
  now: Date,
  result: NotificationDeliveryResult,
): Promise<void> {
  // Same ladder as the webhook dispatcher, imported rather than re-derived:
  // two backoff curves that were meant to be one is how a "small" tuning
  // change ends up applying to half the system.
  const dead = delivery.attempts >= MAX_DELIVERY_ATTEMPTS;
  const nextAttemptAt = dead
    ? now
    : new Date(now.getTime() + nextAttemptDelayMs(delivery.attempts));
  await deps.repos.notificationDeliveries.recordFailure(
    delivery.id,
    error,
    nextAttemptAt,
    dead,
  );
  if (!dead) {
    result.failed += 1;
    return;
  }
  result.dead += 1;
  deps.log?.error(
    { deliveryId: delivery.id, kind: delivery.kind, error },
    "notification delivery dead-lettered",
  );
  if (await enqueueFallback(deps, delivery, now)) result.fellBack += 1;
}

/**
 * Advance the ladder by one rung, and only within the plan.
 *
 * Every bound here matters:
 *
 * - no remembered plan, or a fanned-out one, means no fallback — fan-out
 *   already rang every bell, and a forgotten plan is not one we may
 *   reconstruct from today's policy;
 * - the failed row must appear in that plan, at a known position, or we
 *   refuse rather than invent a destination for it;
 * - candidates are the plan's own later steps, in order, so a channel policy
 *   or bindings excluded can never be selected — it was never in the list;
 * - `existsForEvent` inside `enqueueStep` means each destination is enqueued
 *   at most once per event, so the cascade is finite even if every rung
 *   fails.
 */
async function enqueueFallback(
  deps: NotificationDispatchDeps,
  delivery: NotificationDelivery,
  now: Date,
): Promise<boolean> {
  const record = (deps.plans ?? sharedPlanStore).get(delivery.outboxEventId);
  if (!record || record.plan.fanOut) return false;
  if (record.principalId !== delivery.principalId) return false;
  const index = record.plan.steps.findIndex(
    (step) =>
      step.kind === delivery.kind &&
      (step.bindingId ?? "") === (delivery.bindingId ?? ""),
  );
  if (index < 0) return false;

  for (const step of record.plan.steps.slice(index + 1)) {
    if (!isDeliverableStep(step)) continue;
    const outcome = await enqueueStep(
      deps,
      record,
      step,
      delivery.outboxEventId,
      now,
    );
    if (outcome === "enqueued") {
      deps.log?.info(
        { from: delivery.kind, to: step.kind },
        "notification fell back to the next step in the plan",
      );
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Retraction
 * ------------------------------------------------------------------ */

export interface RetractionResult {
  updated: number;
  failed: number;
  /** Channels that cannot revise a sent message, or held no provider handle. */
  unsupported: number;
}

/**
 * Withdraw or revise the messages for a request that has settled.
 *
 * Best-effort by construction: a Slack message we could not edit is a stale
 * message, and a stale message is not an authorization. Nothing in here
 * touches the request, and a provider failure is logged and counted rather
 * than propagated — letting a failed edit unwind a settled decision would
 * make an unreachable chat API into a veto over authorization state.
 */
export async function retractNotifications(
  deps: NotificationDispatchDeps,
  authReqId: string,
): Promise<RetractionResult> {
  const now = deps.clock();
  const registry = deps.adapters ?? EMPTY_ADAPTER_REGISTRY;
  const rows =
    await deps.repos.notificationDeliveries.listForRequest(authReqId);
  const result: RetractionResult = { updated: 0, failed: 0, unsupported: 0 };

  for (const delivery of rows) {
    const providerMessageRef = delivery.providerMessageRef;
    if (delivery.state !== "delivered" || !providerMessageRef) {
      result.unsupported += 1;
      continue;
    }
    const adapter = registry.get(delivery.kind);
    const update = adapter?.update;
    if (
      !adapter ||
      !update ||
      !adapter.capabilities().supportsNotificationUpdate
    ) {
      result.unsupported += 1;
      continue;
    }
    const binding = delivery.bindingId
      ? await deps.repos.channelBindings.getById(delivery.bindingId)
      : null;
    try {
      await update.call(adapter, {
        delivery,
        providerMessageRef,
        ...(binding ? { binding } : undefined),
        now,
      });
      result.updated += 1;
    } catch (err) {
      result.failed += 1;
      deps.log?.warn(
        {
          deliveryId: delivery.id,
          error: err instanceof Error ? err.name : "update failed",
        },
        "notification retraction failed; authorization state unchanged",
      );
    }
  }
  return result;
}
