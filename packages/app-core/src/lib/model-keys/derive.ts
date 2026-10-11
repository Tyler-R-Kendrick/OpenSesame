/**
 * Deriving a child key: the whole of "may this exchange hand out that much?"
 * (ADR 0188 §4).
 *
 * The rule is one sentence: a key can only ever be narrowed. Each dimension is
 * checked on its own, against what the parent *holds now* and not only what it
 * was issued with, and a request for more is refused outright. It is never
 * trimmed to fit: trimming turns a probe into a map of the parent's limits,
 * and a client that asked for `gpt-4o` and was quietly given `gpt-4o-mini`
 * has been told something false. Time is the one exception: a lifetime longer
 * than the parent's is shortened and `expires_in` says so (RFC 6749 §5.1),
 * because a shorter life is never more authority.
 *
 * The result is checked a second time by the domain's own attenuation
 * validator (`validateAuthorityGrantAttenuation`, INV-GA-01), so the broker's
 * reading of "narrower" and the one every other plane uses cannot drift.
 */
import {
  type AuthorityGrant,
  DomainError,
  parseResourceScope,
  resourcesAttenuate,
  validateAuthorityGrantAttenuation,
} from "@opensesame/os-domain";
import type { ModelAccessRequest } from "./details.js";
import { refuse } from "./errors.js";
import type { ExchangeRequest } from "./request.js";
import type { Allocation, BrokerPolicy, KeyRecord } from "./types.js";
import {
  CAP_OUTPUT_TOKENS,
  CONSUMABLES,
  LIMITS,
  type ModelAction,
} from "./vocabulary.js";

export type Derivation = Readonly<{
  grant: AuthorityGrant;
  allocation: Allocation;
}>;

/** `model:<provider>/<entry>`: `*` is every model of the provider, `a/*` a namespace. */
export function modelSelectors(
  providerId: string,
  entries: readonly string[],
): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const selector = `model:${providerId}/${entry}`;
    try {
      parseResourceScope(selector);
    } catch {
      return refuse("invalid_authorization_details", "models.selector");
    }
    if (!out.includes(selector)) out.push(selector);
  }
  return out;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

function resourceOf(
  parent: KeyRecord,
  request: ExchangeRequest,
  details: ModelAccessRequest | null,
): void {
  const named = [request.resource, details?.locations[0] ?? null].filter(
    (value): value is string => value !== null,
  );
  if (new Set(named).size > 1) refuse("invalid_target", "resource.disagree");
  const audience = parent.provider.baseUrl;
  if (named[0] !== undefined && named[0] !== audience)
    refuse("invalid_target", "escalation.resource");
  if (
    request.audienceProvider !== null &&
    request.audienceProvider !== parent.provider.providerId
  )
    refuse("invalid_target", "escalation.resource");
}

function actionsOf(
  parent: KeyRecord,
  request: ExchangeRequest,
  details: ModelAccessRequest | null,
): ModelAction[] {
  const fromScope = request.actions;
  const fromDetail = details?.actions ?? null;
  if (fromScope && fromDetail && !sameSet(fromScope, fromDetail))
    return refuse("invalid_request", "actions.disagree");
  const asked = fromDetail ?? fromScope;
  const parentActions = parent.grant.actions;
  const chosen =
    asked ??
    parentActions.filter(
      (a): a is ModelAction => a === "model.invoke" || a === "model.list",
    );
  if (chosen.length === 0) return refuse("invalid_scope", "actions.empty");
  for (const action of chosen) {
    if (!parentActions.includes(action))
      return refuse("invalid_scope", "escalation.actions");
  }
  return [...chosen];
}

function modelsOf(
  parent: KeyRecord,
  details: ModelAccessRequest | null,
): string[] {
  if (details?.models == null) return [...parent.grant.resources];
  const asked = modelSelectors(parent.provider.providerId, details.models);
  if (!resourcesAttenuate(asked, parent.grant.resources))
    return refuse("invalid_authorization_details", "escalation.models");
  return asked;
}

function allocationFrom(budget: Readonly<Record<string, number>>): Allocation {
  const { requests, input_tokens, output_tokens } = budget;
  if (
    requests === undefined ||
    input_tokens === undefined ||
    output_tokens === undefined
  )
    return refuse("invalid_authorization_details", "budget.required");
  return { requests, input_tokens, output_tokens };
}

function allocationOf(
  parent: KeyRecord,
  details: ModelAccessRequest | null,
  policy: BrokerPolicy,
) {
  const budget = details?.budget;
  if (!budget)
    return refuse("invalid_authorization_details", "budget.required");
  const allocation = allocationFrom(budget);
  for (const key of CONSUMABLES) {
    if (allocation[key] > (parent.grant.constraints.budgets[key] ?? 0))
      return refuse("invalid_authorization_details", "escalation.budget");
    if (allocation[key] > parent.remaining[key])
      return refuse(
        "invalid_authorization_details",
        "escalation.budget_remaining",
      );
  }
  const parentCap = parent.grant.constraints.budgets[CAP_OUTPUT_TOKENS] ?? 0;
  const cap = budget[CAP_OUTPUT_TOKENS] ?? parentCap;
  if (cap > parentCap || cap > policy.outputTokenCeiling)
    return refuse("invalid_authorization_details", "escalation.budget");
  return { allocation, cap };
}

/** The lifetime in milliseconds, shortened to the parent's remaining life, never extended. */
export function lifetimeOf(
  requested: number | null,
  parentExpiresAt: number,
  policy: BrokerPolicy,
  now: number,
): number {
  const remaining = parentExpiresAt - now;
  if (remaining <= 0) return refuse("invalid_grant", "subject.inactive");
  const wanted = (requested ?? policy.defaultLifetimeSeconds) * 1000;
  const ceiling =
    Math.min(policy.maxLifetimeSeconds, LIMITS.maxLifetimeSeconds) * 1000;
  return Math.min(wanted, ceiling, remaining);
}

export function deriveChild(
  parent: KeyRecord,
  request: ExchangeRequest,
  details: ModelAccessRequest | null,
  context: Readonly<{
    id: string;
    now: number;
    policy: BrokerPolicy;
    requesterClientId: string;
    bindTo: string | null;
  }>,
): Derivation {
  const { grant: held } = parent;
  const depth = held.delegationDepth + 1;
  const maximum = Math.min(
    held.constraints.maximumDelegationDepth,
    context.policy.maxDelegationDepth,
  );
  if (depth > maximum) refuse("invalid_grant", "depth.exceeded");
  resourceOf(parent, request, details);
  const actions = actionsOf(parent, request, details);
  const resources = modelsOf(parent, details);
  const { allocation, cap } = allocationOf(parent, details, context.policy);
  const lifetime = lifetimeOf(
    details?.lifetimeSeconds ?? null,
    held.constraints.expiresAt.getTime(),
    context.policy,
    context.now,
  );
  const grant: AuthorityGrant = {
    ...held,
    id: context.id,
    version: 1,
    actorId: context.requesterClientId,
    actorInstanceId: context.bindTo === null ? null : `jkt:${context.bindTo}`,
    proofKeyThumbprint: context.bindTo,
    actions,
    resources,
    constraints: {
      ...held.constraints,
      notBefore: null,
      expiresAt: new Date(context.now + lifetime),
      budgets: { ...allocation, [CAP_OUTPUT_TOKENS]: cap },
      rawCredentialExport: false,
    },
    parentGrantId: held.id,
    delegationDepth: depth,
    createdAt: new Date(context.now),
    revokedAt: null,
  };
  try {
    validateAuthorityGrantAttenuation(held, grant);
  } catch (error) {
    const why =
      error instanceof DomainError ? String(error.details.why ?? "") : "";
    return refuse("invalid_authorization_details", `attenuation.${why}`);
  }
  return { grant, allocation };
}
