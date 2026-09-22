/**
 * OpenFeature projection of the composition store (S17).
 *
 * Binding: OpenFeature PROJECTS decisions. This provider never owns the
 * snapshot, never loads a module, never requests consent and never decides
 * authority. `loader.ts` and `authority.ts` read `compositionStore` directly;
 * a flag value — from this provider or from any provider registered in its
 * place — reaches UI code only, through `openfeature-consumer.ts` (OF-05).
 *
 * Every resolution reads the CURRENT snapshot, so an event delivered late or
 * out of order can only make a consumer re-read the present; it can never
 * restore a value from an earlier generation (OF-06).
 */
import {
  type Client,
  ErrorCode,
  type EvaluationContext,
  type JsonValue,
  NOOP_PROVIDER,
  OpenFeature,
  OpenFeatureEventEmitter,
  type Paradigm,
  type Provider,
  ProviderEvents,
  type ProviderMetadata,
  type ResolutionDetails,
  StandardResolutionReasons,
} from "@openfeature/web-sdk";
import type {
  CapabilityId,
  CapabilityLifecycle,
  CapabilityState,
  EffectivePlan,
} from "@opensesame/capability-composition";
import {
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { compositionStore } from "./store.js";

export const PROVIDER_NAME = "opensesame-local-composition";
/** One SDK domain, so a second provider bound here is detectable, never silent. */
export const OPENFEATURE_DOMAIN = "opensesame-pages";
export const FLAG_GENERATION = "composition.generation";
export const FLAG_PLAN = "composition.plan";
const CAPABILITY_PREFIX = "capability.";
const LIFECYCLE_SUFFIX = ".lifecycle";

export function capabilityFlagKey(id: CapabilityId): string {
  return `${CAPABILITY_PREFIX}${id}`;
}

export function lifecycleFlagKey(id: CapabilityId): string {
  return `${CAPABILITY_PREFIX}${id}${LIFECYCLE_SUFFIX}`;
}

/**
 * The part of S06's `CompositionSnapshot` this projection reads.
 * `compositionStore` (store.ts §4.1) satisfies `SnapshotSource` unchanged.
 */
export type ProjectedSnapshot = Readonly<{
  status: "resolving" | "ready" | "managed-invalid" | "storage-unavailable";
  plan: EffectivePlan | null;
  generation: number;
  lifecycle: Readonly<Record<CapabilityId, CapabilityLifecycle>>;
}>;

export type SnapshotSource = Readonly<{
  getSnapshot(): ProjectedSnapshot;
  subscribe(listener: () => void): () => void;
}>;

/** The only evaluation context this provider accepts. Nothing else is stored. */
export type ProjectedContext = Readonly<{ vaultId?: string }>;

type ReadyPlan = Readonly<{ plan: EffectivePlan; snapshot: ProjectedSnapshot }>;
type FlagKind = "boolean" | "string" | "number" | "object";
type Reason = "STATIC" | "TARGETING_MATCH";
type ResolvedFlag = Readonly<{
  kind: FlagKind;
  value: JsonValue;
  reason: Reason;
}>;

function stateOf(plan: EffectivePlan, id: string): CapabilityState | undefined {
  return Object.hasOwn(plan.capabilities, id)
    ? plan.capabilities[id]
    : undefined;
}

/** `composition.plan` carries the digest and approved ids only — never policy text. */
function planFlag(plan: EffectivePlan): JsonValue {
  return {
    planDigest: plan.identity.planDigest,
    approvedCapabilities: [...plan.approvedCapabilities],
  };
}

function lookupFlag(key: string, ready: ReadyPlan): ResolvedFlag | null {
  const { plan, snapshot } = ready;
  if (key === FLAG_GENERATION) {
    return { kind: "number", value: snapshot.generation, reason: "STATIC" };
  }
  if (key === FLAG_PLAN) {
    return { kind: "object", value: planFlag(plan), reason: "STATIC" };
  }
  if (!key.startsWith(CAPABILITY_PREFIX)) return null;
  const rest = key.slice(CAPABILITY_PREFIX.length);
  const state = stateOf(plan, rest);
  if (state !== undefined) {
    return {
      kind: "boolean",
      value: state.approved,
      reason: "TARGETING_MATCH",
    };
  }
  if (!rest.endsWith(LIFECYCLE_SUFFIX)) return null;
  const id = rest.slice(0, -LIFECYCLE_SUFFIX.length);
  if (stateOf(plan, id) === undefined) return null;
  const lifecycle = Object.hasOwn(snapshot.lifecycle, id)
    ? snapshot.lifecycle[id]
    : undefined;
  return lifecycle === undefined
    ? null
    : { kind: "string", value: lifecycle, reason: "TARGETING_MATCH" };
}

/** Every flag key with its current value, for `flagsChanged` diffs. */
function flagTable(snapshot: ProjectedSnapshot): Map<string, string> {
  const table = new Map<string, string>();
  if (snapshot.status !== "ready" || snapshot.plan === null) return table;
  table.set(FLAG_GENERATION, String(snapshot.generation));
  table.set(FLAG_PLAN, snapshot.plan.identity.planDigest);
  for (const id of Object.keys(snapshot.plan.capabilities)) {
    table.set(
      capabilityFlagKey(id),
      String(snapshot.plan.capabilities[id]?.approved),
    );
    const lifecycle = Object.hasOwn(snapshot.lifecycle, id)
      ? snapshot.lifecycle[id]
      : undefined;
    if (lifecycle !== undefined) table.set(lifecycleFlagKey(id), lifecycle);
  }
  return table;
}

function changedFlags(
  before: ProjectedSnapshot,
  after: ProjectedSnapshot,
): string[] {
  const a = flagTable(before);
  const b = flagTable(after);
  const changed = new Set<string>();
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(key) !== b.get(key)) changed.add(key);
  }
  if (before.generation !== after.generation) changed.add(FLAG_GENERATION);
  return [...changed].sort();
}

/**
 * Accept `{ vaultId?: string }` and nothing else. A richer context would be a
 * channel for sensitive data into a telemetry-shaped API; it is refused.
 */
export function projectedContext(context: EvaluationContext): ProjectedContext {
  for (const key of Object.keys(context)) {
    if (key !== "vaultId") {
      throw new Error(`${ErrorCode.INVALID_CONTEXT}: unsupported context key`);
    }
  }
  const vaultId = context.vaultId;
  if (vaultId === undefined) return {};
  if (!isString(vaultId)) {
    throw new Error(`${ErrorCode.INVALID_CONTEXT}: vaultId must be a string`);
  }
  return { vaultId };
}

function errorDetails<T>(
  defaultValue: T,
  errorCode: ErrorCode,
  generation: number,
): ResolutionDetails<T> {
  return {
    value: defaultValue,
    reason: StandardResolutionReasons.ERROR,
    errorCode,
    flagMetadata: { generation },
  };
}

export class LocalCompositionProvider implements Provider {
  readonly metadata: ProviderMetadata = { name: PROVIDER_NAME };
  readonly runsOn: Paradigm = "client";
  readonly events = new OpenFeatureEventEmitter();
  readonly #source: SnapshotSource;
  #unsubscribe: (() => void) | null = null;
  #last: ProjectedSnapshot;
  #context: ProjectedContext = {};

  constructor(source: SnapshotSource) {
    this.#source = source;
    this.#last = source.getSnapshot();
  }

  /** Offline by construction: reads the store, subscribes, touches no network. */
  async initialize(context?: EvaluationContext): Promise<void> {
    this.#context = projectedContext(context ?? {});
    this.#last = this.#source.getSnapshot();
    this.#unsubscribe ??= this.#source.subscribe(() => this.#onStoreChange());
  }

  onContextChange(_old: EvaluationContext, next: EvaluationContext): void {
    this.#context = projectedContext(next);
  }

  /** What the provider retained from the context — never more than a vault id. */
  context(): ProjectedContext {
    return this.#context;
  }

  subscribed(): boolean {
    return this.#unsubscribe !== null;
  }

  async onClose(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  #onStoreChange(): void {
    const before = this.#last;
    const after = this.#source.getSnapshot();
    this.#last = after;
    if (
      before.generation === after.generation &&
      before.status === after.status
    )
      return;
    const wasReady = before.status === "ready" && before.plan !== null;
    const isReady = after.status === "ready" && after.plan !== null;
    if (wasReady && !isReady) this.events.emit(ProviderEvents.Stale);
    if (!wasReady && isReady) this.events.emit(ProviderEvents.Ready);
    this.events.emit(ProviderEvents.ConfigurationChanged, {
      flagsChanged: changedFlags(before, after),
    });
  }

  #resolve(
    key: string,
    defaultValue: JsonValue,
    kind: FlagKind,
  ): ResolutionDetails<JsonValue> {
    const snapshot = this.#source.getSnapshot();
    const generation = snapshot.generation;
    if (snapshot.status !== "ready" || snapshot.plan === null) {
      return errorDetails(
        defaultValue,
        ErrorCode.PROVIDER_NOT_READY,
        generation,
      );
    }
    const flag = lookupFlag(key, { plan: snapshot.plan, snapshot });
    if (flag === null) {
      return errorDetails(defaultValue, ErrorCode.FLAG_NOT_FOUND, generation);
    }
    if (flag.kind !== kind) {
      return errorDetails(defaultValue, ErrorCode.TYPE_MISMATCH, generation);
    }
    return {
      value: flag.value,
      reason: StandardResolutionReasons[flag.reason],
      flagMetadata: { generation },
    };
  }

  resolveBooleanEvaluation(
    key: string,
    defaultValue: boolean,
  ): ResolutionDetails<boolean> {
    const details = this.#resolve(key, defaultValue, "boolean");
    const value = isBoolean(details.value) ? details.value : defaultValue;
    return { ...details, value };
  }

  resolveStringEvaluation(
    key: string,
    defaultValue: string,
  ): ResolutionDetails<string> {
    const details = this.#resolve(key, defaultValue, "string");
    const value = isString(details.value) ? details.value : defaultValue;
    return { ...details, value };
  }

  resolveNumberEvaluation(
    key: string,
    defaultValue: number,
  ): ResolutionDetails<number> {
    const details = this.#resolve(key, defaultValue, "number");
    const value = isNumber(details.value) ? details.value : defaultValue;
    return { ...details, value };
  }

  resolveObjectEvaluation<T extends JsonValue>(
    key: string,
    defaultValue: T,
  ): ResolutionDetails<T> {
    const details = this.#resolve(key, defaultValue, "object");
    if (!isJsonObject(details.value))
      return { ...details, value: defaultValue };
    // SAFETY: the SDK's object flags are untyped JSON; the only object flag
    // here is `composition.plan`, whose members are documented above.
    const value: T = overlapCast(details.value);
    return { ...details, value };
  }
}

export type InstalledCompositionProvider = Readonly<{
  client: Client;
  provider: LocalCompositionProvider;
  dispose(): Promise<void>;
}>;

/**
 * The store the provider projects. `compositionStore` (S06) satisfies
 * `SnapshotSource` as-is; tests inject a store double here or pass one to
 * `installCompositionProvider` directly.
 */
export const openfeatureSeams: { snapshotSource: SnapshotSource } = {
  snapshotSource: compositionStore,
};

/** The provider currently bound to our domain, when it is ours. */
export function installedCompositionProvider(): LocalCompositionProvider | null {
  const bound = OpenFeature.getProvider(OPENFEATURE_DOMAIN);
  return bound instanceof LocalCompositionProvider ? bound : null;
}

/** True when something other than our provider answers for our domain. */
export function foreignProviderInstalled(): boolean {
  const bound = OpenFeature.getProvider(OPENFEATURE_DOMAIN);
  return (
    bound !== NOOP_PROVIDER && !(bound instanceof LocalCompositionProvider)
  );
}

/**
 * Bind a fresh provider to `OPENFEATURE_DOMAIN`. The SDK closes the provider
 * it replaces, which drops that provider's store subscription (OF-07).
 */
export async function installCompositionProvider(
  options: { snapshotSource?: SnapshotSource } = {},
): Promise<InstalledCompositionProvider> {
  const source = options.snapshotSource ?? openfeatureSeams.snapshotSource;
  const provider = new LocalCompositionProvider(source);
  await OpenFeature.setProviderAndWait(OPENFEATURE_DOMAIN, provider);
  const client = OpenFeature.getClient(OPENFEATURE_DOMAIN);
  return {
    client,
    provider,
    async dispose() {
      if (OpenFeature.getProvider(OPENFEATURE_DOMAIN) === provider) {
        await OpenFeature.setProviderAndWait(OPENFEATURE_DOMAIN, NOOP_PROVIDER);
      }
      await provider.onClose();
    },
  };
}
