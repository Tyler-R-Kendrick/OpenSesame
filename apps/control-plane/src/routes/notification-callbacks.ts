import { createHash } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import {
  type AuthorizationRequest,
  type ExternalChannelBinding,
  approvalTransactionDigest,
  evaluateComparison,
} from "@opensesame/os-domain";
import { evaluateApprovalCeremony } from "@opensesame/trust-broker";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppContext } from "../context.js";
import type { Variables } from "../middleware/context.js";
import {
  comparisonValueDigest,
  principalEvidence,
  recordSettlement,
  resolveCallbackTransactionRef,
} from "./approval-ceremony.js";
import { resolveApprovalPolicy } from "./approval-policy.js";

/**
 * Provider callbacks (ADR 0081).
 *
 * This route is unauthenticated, and it has to be: Slack cannot hold our
 * bearer token, and a provider that could would be a provider whose
 * compromise is our compromise. What defends it is a chain, run in this order
 * and no other:
 *
 *  1. capture the raw bytes, before anything parses them;
 *  2. the adapter checks the provider's own signature over those bytes, and
 *     the freshness of the timestamp that signature covers;
 *  3. only then parse;
 *  4. extract a stable (provider, tenant, subject) — never a display name;
 *  5. resolve that triple, all three components, to a binding;
 *  6. claim the callback in the replay ledger, where the *insert* is the
 *     claim;
 *  7. resolve the opaque transaction reference to a request;
 *  8. ask `evaluateApprovalCeremony` whether this may settle;
 *  9. settle atomically if it may;
 * 10. write a receipt and an audit line made of digests.
 *
 * The order is not stylistic. Parsing before verifying hands attacker-chosen
 * structure to a parser; checking the ledger before claiming it is a race two
 * replicas lose together; resolving the binding by subject alone lets anyone
 * who controls their own workspace mint a colliding identity.
 *
 * Every exit is the same ack. A callback for a request that does not exist,
 * one for a revoked binding and one that settles a decision are
 * indistinguishable from outside — otherwise this route answers, for any
 * transaction reference, whether it names something real.
 */

/** How long a claimed callback stays in the ledger. */
const REPLAY_RETENTION_MS = 24 * 60 * 60_000;

/**
 * A courtesy fence on an unauthenticated route.
 *
 * Explicitly *not* the defence: the chain above is. This exists so a flood of
 * unsigned bodies costs an HMAC and a map insert rather than a database
 * round-trip, and it is process-local for the same reason the poll pacer is —
 * nothing is refused on security grounds because of it.
 */
const CALLBACK_WINDOW_MS = 60_000;
const CALLBACK_MAX_PER_CLIENT = 60;
const CALLBACK_MAX_GLOBAL = 600;
const CALLBACK_FENCE_ENTRIES = 4096;

function callbackFingerprint(c: Context<{ Variables: Variables }>): string {
  return createHash("sha256")
    .update(c.req.header("user-agent") ?? "")
    .update("|")
    .update(c.req.header("x-forwarded-for") ?? "")
    .digest("hex")
    .slice(0, 16);
}

export function consumeCallbackBudget(
  map: Map<string, number[]>,
  fingerprint: string,
  now: number,
): boolean {
  for (const [key, values] of map) {
    const live = values.filter((at) => now - at < CALLBACK_WINDOW_MS);
    if (live.length === 0) map.delete(key);
    else if (live.length !== values.length) map.set(key, live);
  }
  const global = map.get("__global__") ?? [];
  const client = map.get(fingerprint) ?? [];
  if (
    global.length >= CALLBACK_MAX_GLOBAL ||
    client.length >= CALLBACK_MAX_PER_CLIENT
  ) {
    return false;
  }
  global.push(now);
  client.push(now);
  map.set("__global__", global);
  map.set(fingerprint, client);
  while (map.size > CALLBACK_FENCE_ENTRIES) {
    const victim = [...map.keys()].find((key) => !key.startsWith("__"));
    if (victim === undefined) break;
    map.delete(victim);
  }
  return true;
}

export const notificationCallbackRoutes = new Hono<{ Variables: Variables }>();

/**
 * The one answer this route gives.
 *
 * Slack wants a 200 and an empty body; so does every other provider whose
 * retry logic reads a status code. It says nothing about whether a request
 * existed, whether a binding matched, or whether anything was settled.
 */
function ack(c: Context<{ Variables: Variables }>) {
  return c.json({ ok: true }, 200);
}

interface CallbackDenial {
  providerId: string;
  callbackDigest: string;
  reason: string;
  authReqId?: string;
  bindingId?: string;
}

async function auditCallbackDenial(
  ctx: AppContext,
  c: Context<{ Variables: Variables }>,
  input: CallbackDenial,
): Promise<void> {
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "authority.callback.denied",
    actorType: "system",
    outcome: "denied",
    correlationId: c.get("correlationId"),
    // Digests and reason codes only. No provider payload, no display name, no
    // comparison value: a refused callback is attacker-supplied text, and an
    // audit trail is not the place to store attacker-supplied text.
    metadata: {
      providerId: input.providerId,
      callbackDigest: input.callbackDigest,
      reason: input.reason,
      ...(input.authReqId ? { authReqId: input.authReqId } : undefined),
      ...(input.bindingId ? { bindingId: input.bindingId } : undefined),
    },
  });
}

notificationCallbackRoutes.post("/:provider", async (c) => {
  const ctx = c.get("ctx");
  const now = ctx.clock();
  if (
    !consumeCallbackBudget(
      ctx.stores.notificationCallbacks,
      callbackFingerprint(c),
      now.getTime(),
    )
  ) {
    return c.json({ ok: false, error: "rate_limited" }, 429);
  }

  // 1. The raw bytes, first. A signature checked against a re-serialized body
  //    checks a different message than the one that arrived.
  const raw = new Uint8Array(await c.req.arrayBuffer());
  const provider = c.req.param("provider") ?? "";
  const adapter = ctx.notificationCallbackAdapters[provider];
  // An unconfigured provider answers exactly as an unknown one does.
  if (!adapter) return ack(c);

  // 2. Provenance and freshness, over those bytes.
  const verification = adapter.verify({
    raw,
    header: (name) => c.req.header(name),
    now,
  });
  if (!verification.authenticated || !verification.fresh) {
    await auditCallbackDenial(ctx, c, {
      providerId: adapter.providerId,
      callbackDigest: verification.callbackDigest,
      // The adapter's own classification when it has one: an operator
      // debugging a clock and one debugging a rotated secret need to be able
      // to tell their situations apart, even though the caller never can.
      reason:
        verification.refusal ??
        (verification.authenticated ? "callback_stale" : "unauthenticated"),
    });
    return ack(c);
  }

  // 3. Only now is it safe to parse.
  const claim = adapter.parse(raw);
  if (!claim) {
    await auditCallbackDenial(ctx, c, {
      providerId: adapter.providerId,
      callbackDigest: verification.callbackDigest,
      reason: "unparseable",
    });
    return ack(c);
  }

  // 4/5. The stable triple, resolved as a triple. Subject ids are unique
  //      within a tenant and not across them, so a lookup by subject alone
  //      lets an attacker who controls their own workspace mint an identity
  //      that collides with somebody else's binding.
  const binding: ExternalChannelBinding | null =
    await ctx.repos.channelBindings.findByProviderIdentity(
      adapter.kind,
      claim.providerId,
      claim.providerTenantId,
      claim.providerSubjectId,
    );

  // 6. The insert *is* the claim. Checking then inserting is a race an
  //    attacker replaying into two replicas wins.
  const first = await ctx.repos.callbackReplays.claim({
    id: `${claim.providerId}:${verification.callbackDigest}`,
    providerId: claim.providerId,
    callbackDigest: verification.callbackDigest,
    seenAt: now,
    expiresAt: new Date(now.getTime() + REPLAY_RETENTION_MS),
  });
  if (!first) {
    await auditCallbackDenial(ctx, c, {
      providerId: claim.providerId,
      callbackDigest: verification.callbackDigest,
      reason: "callback_replayed",
      ...(binding ? { bindingId: binding.id } : undefined),
    });
    return ack(c);
  }

  // 7. The reference is a MAC over the request id *and* the decision, so a
  //    reference minted for "deny" cannot be presented with an approve
  //    action, and one cannot be forged for a request the sender was never
  //    told about.
  const resolved = resolveCallbackTransactionRef(
    claim.transactionRef,
    ctx.config.claimPepper,
  );
  if (!resolved || resolved.decision !== claim.decision) {
    await auditCallbackDenial(ctx, c, {
      providerId: claim.providerId,
      callbackDigest: verification.callbackDigest,
      reason: "unresolvable_transaction_reference",
    });
    return ack(c);
  }
  const row: AuthorizationRequest | null =
    await ctx.repos.authorizationRequests.getById(resolved.authReqId);
  if (!row) {
    await auditCallbackDenial(ctx, c, {
      providerId: claim.providerId,
      callbackDigest: verification.callbackDigest,
      reason: "request_not_found",
    });
    return ack(c);
  }

  const { policy, policyDigest } = resolveApprovalPolicy({
    authorizationDetails: row.authorizationDetails,
    deployment: {
      directApprovalChannels: ctx.config.notifications.directApprovalChannels,
      directDenialChannels: ctx.config.notifications.directDenialChannels,
    },
  });
  // The approver is whoever the binding names — never anything the callback
  // said about itself. With no binding there is no approver, and the
  // evaluator refuses on `approver_mismatch` rather than guessing.
  const approverPrincipalId = binding?.principalId ?? "";
  const transactionDigest = approvalTransactionDigest({
    authReqId: row.id,
    requestDigest: row.requestDigest,
    approverPrincipalId,
    decision: claim.decision,
    policyDigest,
    channelKind: adapter.kind,
  });

  let comparisonSatisfied = false;
  if (policy.requireComparison && claim.comparisonValue) {
    const challenge = await ctx.repos.comparisonChallenges.consumeAttempt(
      row.id,
      now,
    );
    comparisonSatisfied = evaluateComparison({
      ...(challenge ? { challenge } : undefined),
      presentedDigest: comparisonValueDigest(
        row.id,
        claim.comparisonValue,
        ctx.config.claimPepper,
      ),
      now,
    }).satisfied;
  }

  const principal = approverPrincipalId
    ? await ctx.repos.principals.getById(approverPrincipalId)
    : null;
  // 8. One evaluator, the same one the in-app ceremony uses. Note what is
  //    *not* passed: `activationAuthentication`. A provider callback cannot
  //    run a WebAuthn ceremony, so the strongest facts it may contribute are
  //    the channel's own ceiling — which is why a policy demanding phishing
  //    resistance can never be satisfied from here, and says so.
  const decision = evaluateApprovalCeremony({
    decision: claim.decision,
    path: "external_direct",
    channelKind: adapter.kind,
    policy,
    approverPrincipalId,
    requestPrincipalId: row.principalId,
    authReqId: row.id,
    evidence: principal
      ? principalEvidence(principal, ctx.config.issuer, {
          methods: [`channel:${adapter.kind}`],
          userVerification: "none",
          deviceBinding: "none",
          keyProtection: "unknown",
          syncability: "unknown",
        })
      : [],
    ...(binding ? { binding } : undefined),
    claimedIdentity: {
      providerId: claim.providerId,
      providerTenantId: claim.providerTenantId,
      providerSubjectId: claim.providerSubjectId,
    },
    expectedTransactionDigest: transactionDigest,
    expectedPolicyDigest: policyDigest,
    callbackAuthenticated: verification.authenticated,
    callbackFresh: verification.fresh,
    // Named, not asserted: the evaluator checks the mechanism against what
    // this channel can attest, so an adapter cannot claim a provider
    // timestamp on a channel that stamps nothing.
    freshnessSource: verification.freshnessSource,
    // The ledger already told us, durably, that we are the first to see this.
    callbackUnseen: true,
    requestPending:
      row.status === "pending" && row.expiresAt.getTime() > now.getTime(),
    requestDigestMatches: true,
    comparisonSatisfied,
    now,
  });
  if (!decision.allowed) {
    await auditCallbackDenial(ctx, c, {
      providerId: claim.providerId,
      callbackDigest: verification.callbackDigest,
      reason: decision.refusals.join(","),
      authReqId: row.id,
      ...(binding ? { bindingId: binding.id } : undefined),
    });
    return ack(c);
  }

  // 9/10. Settle, and write the receipt that records what was demanded as
  //       well as what was met.
  const outcome = await recordSettlement({
    ctx,
    row,
    decision: claim.decision,
    approverPrincipalId,
    path: "external_direct",
    channelKind: adapter.kind,
    policy,
    policyDigest,
    transactionDigest,
    ...(binding ? { bindingId: binding.id } : undefined),
    comparisonRequired: policy.requireComparison,
    comparisonSatisfied,
    required: decision.required,
    achieved: decision.achieved,
    evidenceIds: decision.assurance.evidence,
    callbackDigest: verification.callbackDigest,
    ...(c.get("correlationId")
      ? { correlationId: c.get("correlationId") }
      : undefined),
    now,
    publish: true,
  });
  if (!outcome.ok) {
    await auditCallbackDenial(ctx, c, {
      providerId: claim.providerId,
      callbackDigest: verification.callbackDigest,
      reason: outcome.reason,
      authReqId: row.id,
      ...(binding ? { bindingId: binding.id } : undefined),
    });
  }
  return ack(c);
});
