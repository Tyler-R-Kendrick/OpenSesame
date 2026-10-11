import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import {
  type BrokerCore,
  asRefusal,
  emit,
  mintKey,
  newId,
  refusalEvent,
} from "./core.js";
import { deriveChild } from "./derive.js";
import { parseModelAccessDetails } from "./details.js";
/**
 * RFC 8693 token exchange for model keys (ADR 0192 §3–§4).
 *
 * `exchange` is the whole path from a request's parameters to a derived key,
 * in the order that keeps a refusal from teaching a prober anything: shape,
 * then who is asking, then proof of possession, and only then what they asked
 * for. The proof and the digest are awaited, and the ledger can change while
 * they are, so the commit at the end looks the parent up again and re-checks
 * it: a key revoked while its exchange was in flight is not extended.
 */
import { verifyDpopProof } from "./dpop.js";
import { refuse } from "./errors.js";
import { type ExchangeRequest, parseExchangeRequest } from "./request.js";
import type { KeyRecord } from "./types.js";
import { ACCESS_TOKEN_TYPE, CONSUMABLES, LIMITS } from "./vocabulary.js";

export type ExchangeContext = Readonly<{
  /** The client the channel authenticated. It must be the key's own client. */
  clientId: string;
  /** The token endpoint's URL: the `htu` an exchange proof is bound to. */
  endpoint: string;
  /** The `DPoP` header's value, when the request carried one. */
  dpopProof?: string;
}>;

/** One RFC 9396 `model_access` detail, as an exchange answers it. */
export type ModelAccessDetail = Readonly<{
  type: "model_access";
  locations: readonly string[];
  actions: readonly string[];
  models: readonly string[];
  budget: Readonly<Record<string, number>>;
}>;

export type ExchangeResponse = Readonly<{
  access_token: string;
  issued_token_type: string;
  token_type: "DPoP" | "Bearer";
  expires_in: number;
  scope: string;
  resource: string;
  authorization_details: readonly ModelAccessDetail[];
}>;

function subjectOf(
  core: BrokerCore,
  digest: string,
  clientId: string,
  now: number,
): KeyRecord {
  const record = core.ledger.findByDigest(digest);
  if (!record) return refuse("invalid_grant", "subject.unknown");
  if (!core.ledger.isActive(record, now))
    return refuse("invalid_grant", "subject.inactive");
  if (record.grant.clientId !== clientId)
    return refuse("invalid_grant", "subject.foreign_client");
  const connection = core.ports.connection(record.grant.connectionId ?? "");
  if (
    !connection ||
    !connection.verified ||
    connection.providerId !== record.provider.providerId
  )
    return refuse("invalid_grant", "connection.unavailable");
  return record;
}

async function provedKey(
  core: BrokerCore,
  parent: KeyRecord,
  request: ExchangeRequest,
  context: ExchangeContext,
  now: number,
): Promise<string | null> {
  const bound = parent.grant.proofKeyThumbprint;
  if (context.dpopProof === undefined) {
    if (bound !== null) return refuse("invalid_dpop_proof", "dpop.required");
    return null;
  }
  const presented = {
    proof: context.dpopProof,
    method: "POST",
    url: context.endpoint,
    token: request.subjectToken,
    now,
    replay: core.replay,
  };
  const verified = await verifyDpopProof(
    bound === null ? presented : { ...presented, expectedJkt: bound },
  );
  return verified.jkt;
}

function selectorEntries(
  resources: readonly string[],
  providerId: string,
): string[] {
  const head = `model:${providerId}/`;
  return resources.map((selector) => selector.slice(head.length));
}

export async function exchangeKey(
  core: BrokerCore,
  raw: BoundaryValue,
  context: ExchangeContext,
): Promise<ExchangeResponse> {
  const now = core.ledger.clock(core.ports.now());
  let parent: KeyRecord | null = null;
  try {
    const request = parseExchangeRequest(raw);
    const details = request.details
      ? parseModelAccessDetails(request.details)
      : null;
    const digest = await core.ports.sha256(request.subjectToken);
    parent = subjectOf(core, digest, context.clientId, now);
    const proven = await provedKey(core, parent, request, context, now);
    const bindTo = request.dpopJkt ?? proven;
    if (bindTo === null && core.policy.senderConstraint === "dpop_required")
      return refuse("invalid_dpop_proof", "dpop.required");
    const minted = await mintKey(core);
    // Everything below is synchronous: nothing can change between the checks and the write.
    const at = core.ledger.clock(core.ports.now());
    parent = subjectOf(core, digest, context.clientId, at);
    core.ledger.reclaim(at);
    if (
      core.ledger.liveChildren(parent.id, at).length >= LIMITS.maxChildrenPerKey
    )
      return refuse("access_denied", "children.limit");
    const derived = deriveChild(parent, request, details, {
      id: newId(core),
      now: at,
      policy: core.policy,
      requesterClientId: context.clientId,
      bindTo,
    });
    // Room first, then the write: `add` can refuse, and a refused exchange takes nothing from its parent.
    core.ledger.purge();
    core.ledger.add({
      id: derived.grant.id,
      digest: minted.digest,
      grant: derived.grant,
      provider: parent.provider,
      rootId: parent.rootId,
      actors: [
        { clientId: context.clientId, keyThumbprint: bindTo },
        ...parent.actors,
      ],
      remaining: { ...derived.allocation },
      inflight: 0,
      revokedAt: null,
      returned: false,
    });
    for (const key of CONSUMABLES)
      parent.remaining[key] -= derived.allocation[key];
    emit(
      core,
      {
        type: "exchange.issued",
        keyId: derived.grant.id,
        parentId: parent.id,
        clientId: context.clientId,
        providerId: parent.provider.providerId,
      },
      at,
    );
    return {
      access_token: minted.token,
      issued_token_type: ACCESS_TOKEN_TYPE,
      token_type: bindTo === null ? "Bearer" : "DPoP",
      expires_in: Math.floor(
        (derived.grant.constraints.expiresAt.getTime() - at) / 1000,
      ),
      scope: derived.grant.actions.join(" "),
      resource: parent.provider.baseUrl,
      authorization_details: [
        {
          type: "model_access",
          locations: [parent.provider.baseUrl],
          actions: derived.grant.actions,
          models: selectorEntries(
            derived.grant.resources,
            parent.provider.providerId,
          ),
          budget: derived.grant.constraints.budgets,
        },
      ],
    };
  } catch (error) {
    // A caught value is anything at all; `asRefusal` is the check.
    const refusal = asRefusal(overlapCast(error));
    if (refusal)
      emit(
        core,
        refusalEvent("exchange.refused", refusal, parent, context.clientId),
        now,
      );
    throw error;
  }
}
