/**
 * A root key: the authority a person hands an app or an agent (ADR 0192 §3).
 *
 * Every other key descends from one of these, and nothing else creates one, so
 * "nobody can mint authority they were not given" is a statement about this
 * file. A root is built from a *draft* the person approved: the draft is
 * validated against the catalog and the saved connection, digested, and issued
 * only against a proof that a person approved that exact digest
 * (`proofs/model-grant-approval.ts`).
 */
import type { AuthorityGrant } from "@opensesame/os-domain";
import { modelSelectors } from "./derive.js";
import { parseModelAccessDetails } from "./details.js";
import { refuse } from "./errors.js";
import { canonicalResource } from "./resource.js";
import type {
  BrokerPolicy,
  BrokerPorts,
  KeyRecord,
  ProviderTarget,
} from "./types.js";
import {
  CAP_OUTPUT_TOKENS,
  CONSUMABLES,
  DETAIL_TYPE,
  LIMITS,
  type ModelAction,
} from "./vocabulary.js";

export type ModelGrantDraft = Readonly<{
  /** The person approving: the grant is theirs and answers to them. */
  issuerPrincipalId: string;
  organizationId: string;
  /** The application or agent the key is for; every key below it is accountable to it. */
  clientId: string;
  connectionId: string;
  resource: string;
  actions: readonly ModelAction[];
  /** Model ids, `*`, or `namespace/*`, as the person chose them. */
  models: readonly string[];
  budget: Readonly<{
    requests: number;
    input_tokens: number;
    output_tokens: number;
    max_output_tokens: number;
  }>;
  lifetimeSeconds: number;
  maximumDelegationDepth: number;
  /** The key the root is bound to; required while senders must be constrained. */
  dpopJkt: string | null;
}>;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

/** What an approval is bound to: the draft's every field, in a fixed order. */
export function modelGrantDigestInput(draft: ModelGrantDraft): string {
  return JSON.stringify([
    "opensesame:model-grant:v1",
    draft.issuerPrincipalId,
    draft.organizationId,
    draft.clientId,
    draft.connectionId,
    draft.resource,
    [...draft.actions].sort(),
    [...draft.models].sort(),
    draft.budget.requests,
    draft.budget.input_tokens,
    draft.budget.output_tokens,
    draft.budget.max_output_tokens,
    draft.lifetimeSeconds,
    draft.maximumDelegationDepth,
    draft.dpopJkt,
  ]);
}

export function modelGrantDigest(
  draft: ModelGrantDraft,
  sha256: BrokerPorts["sha256"],
): Promise<string> {
  return sha256(modelGrantDigestInput(draft));
}

export type ValidatedDraft = Readonly<{
  provider: ProviderTarget;
  selectors: readonly string[];
}>;

/** Every principal, organization, client and connection id is a plain identifier. */
function checkIdentifiers(draft: ModelGrantDraft): void {
  const fields = [
    draft.issuerPrincipalId,
    draft.organizationId,
    draft.clientId,
    draft.connectionId,
  ];
  if (!fields.every((field) => IDENTIFIER.test(field)))
    refuse("invalid_request", "draft.identifier");
}

/** The saved connection must be a verified one, for the provider the resource names. */
function checkConnection(
  draft: ModelGrantDraft,
  provider: ProviderTarget,
  ports: BrokerPorts,
): void {
  const connection = ports.connection(draft.connectionId);
  if (
    !connection ||
    connection.providerId !== provider.providerId ||
    !connection.verified
  )
    refuse("invalid_target", "draft.connection");
}

/** The same grammar a derived request is held to, so a root cannot say what a child could not. */
function checkGrammar(draft: ModelGrantDraft, resource: string): void {
  const parsed = parseModelAccessDetails([
    {
      type: DETAIL_TYPE,
      locations: [resource],
      actions: [...draft.actions],
      models: [...draft.models],
      budget: { ...draft.budget },
      lifetime_seconds: draft.lifetimeSeconds,
    },
  ]);
  const budget = parsed.budget;
  if (!budget || CONSUMABLES.some((key) => budget[key] === undefined))
    refuse("invalid_authorization_details", "budget.required");
}

/** What the policy caps: the output a call may ask for, and how long a root may live. */
function checkCeilings(draft: ModelGrantDraft, policy: BrokerPolicy): void {
  if (draft.budget.max_output_tokens > policy.outputTokenCeiling)
    refuse("invalid_authorization_details", "budget.ceiling");
  if (draft.lifetimeSeconds > policy.rootMaxLifetimeSeconds)
    refuse("invalid_authorization_details", "lifetime.ceiling");
}

function checkDepth(draft: ModelGrantDraft, policy: BrokerPolicy): void {
  const depthCeiling = Math.min(
    policy.maxDelegationDepth,
    LIMITS.maxDelegationDepth,
  );
  if (
    !Number.isInteger(draft.maximumDelegationDepth) ||
    draft.maximumDelegationDepth < 0 ||
    draft.maximumDelegationDepth > depthCeiling
  )
    refuse("invalid_request", "draft.depth");
}

/** Refuse a draft that the catalog, the connection or the policy does not support. */
export function validateDraft(
  draft: ModelGrantDraft,
  ports: BrokerPorts,
  policy: BrokerPolicy,
): ValidatedDraft {
  checkIdentifiers(draft);
  const resource = canonicalResource(draft.resource);
  const provider = ports.providerForResource(resource);
  if (!provider) return refuse("invalid_target", "draft.resource");
  checkConnection(draft, provider, ports);
  checkGrammar(draft, resource);
  checkCeilings(draft, policy);
  checkDepth(draft, policy);
  if (policy.senderConstraint === "dpop_required" && draft.dpopJkt === null)
    return refuse("invalid_dpop_proof", "dpop.required");
  return {
    provider,
    selectors: modelSelectors(provider.providerId, draft.models),
  };
}

export function rootRecord(
  draft: ModelGrantDraft,
  checked: ValidatedDraft,
  context: Readonly<{ id: string; digest: string; now: number }>,
): KeyRecord {
  const grant: AuthorityGrant = {
    id: context.id,
    version: 1,
    issuerPrincipalId: draft.issuerPrincipalId,
    beneficiaryPrincipalId: draft.issuerPrincipalId,
    actorId: draft.clientId,
    clientId: draft.clientId,
    actorInstanceId: draft.dpopJkt === null ? null : `jkt:${draft.dpopJkt}`,
    proofKeyThumbprint: draft.dpopJkt,
    organizationId: draft.organizationId,
    projectId: null,
    environmentId: null,
    connectionId: draft.connectionId,
    actions: [...draft.actions],
    resources: [...checked.selectors],
    constraints: {
      audiences: [checked.provider.baseUrl],
      notBefore: null,
      expiresAt: new Date(context.now + draft.lifetimeSeconds * 1000),
      requiredAssurance: "phishing-resistant",
      authenticationMaxAgeSeconds: 300,
      allowedNetworks: [],
      parameterRulesDigest: null,
      budgets: {
        requests: draft.budget.requests,
        input_tokens: draft.budget.input_tokens,
        output_tokens: draft.budget.output_tokens,
        [CAP_OUTPUT_TOKENS]: draft.budget.max_output_tokens,
      },
      maximumDelegationDepth: draft.maximumDelegationDepth,
      offlineUse: "forbidden",
      rawCredentialExport: false,
    },
    parentGrantId: null,
    delegationDepth: 0,
    createdAt: new Date(context.now),
    revokedAt: null,
  };
  return {
    id: context.id,
    digest: context.digest,
    grant,
    provider: checked.provider,
    rootId: context.id,
    actors: [{ clientId: draft.clientId, keyThumbprint: draft.dpopJkt }],
    remaining: {
      requests: draft.budget.requests,
      input_tokens: draft.budget.input_tokens,
      output_tokens: draft.budget.output_tokens,
    },
    inflight: 0,
    revokedAt: null,
    returned: false,
  };
}
