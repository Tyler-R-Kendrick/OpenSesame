import type { VerifiedProviderIdentity } from "@opensesame/agent-protocols";
import { agentAuthError } from "@opensesame/agent-protocols";
import { appendAuditEvent } from "@opensesame/audit";
import { createProvisionalPrincipal } from "@opensesame/auth-upstream";
import {
  type AgentRegistration,
  type Principal,
  generateAgentClaimToken,
  generateAgentRegistrationId,
} from "@opensesame/os-domain";
import type { JsonObject } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import { commitProviderRegistration } from "./agent-auth-id-jag-persist.js";
import { resolveProviderRegistration } from "./agent-auth-id-jag-resolve.js";
import { consumeProviderReplay } from "./agent-auth-id-jag-trust.js";
import { providerAssertionIsAdvertised } from "./agent-auth-id-jag-trust.js";
import { verifyProviderAssertionRequest } from "./agent-auth-id-jag-verify.js";
import { startClaimAttempt } from "./agent-auth-shared.js";

export { providerAssertionIsAdvertised } from "./agent-auth-id-jag-trust.js";

export async function registerProviderAssertion(
  ctx: AppContext,
  input: { assertionType: string; assertion: string },
  headers: { userAgent?: string; origin?: string },
  correlationId: string,
): Promise<Record<string, unknown>> {
  const identity = await verifyProviderAssertionRequest(ctx, input, headers);
  const resolved = await resolveProviderRegistration(
    ctx,
    identity,
    correlationId,
    beginProviderFirstLink,
  );
  return commitProviderRegistration(ctx, {
    identity,
    principal: resolved.principal,
    registration: resolved.registration,
    existing: resolved.existing,
    identityRow: resolved.identityRow,
    now: resolved.now,
    correlationId,
  });
}

function firstLinkRequired(
  ctx: AppContext,
  registration: AgentRegistration,
  claim: { token: string },
  ceremony: { claim: JsonObject },
): never {
  throw agentAuthError(
    "interaction_required",
    401,
    "First-link step-up is required to bind this identity.",
    {
      registration_id: registration.id,
      registration_type: "identity_assertion",
      claim_url: `${ctx.config.publicUrl}/agent/identity/claim`,
      claim_token: claim.token,
      claim_token_expires: registration.expiresAt.toISOString(),
      post_claim_scopes: [...registration.postClaimScopes],
      claim: ceremony.claim as JsonObject,
    },
  );
}
async function beginProviderFirstLink(
  ctx: AppContext,
  identity: {
    issuer: string;
    subject: string;
    assertionId: string;
    expiresAt: Date;
    clientId?: string;
  },
  verifiedEmail: string,
  correlationId: string,
): Promise<never> {
  const cfg = ctx.config.agentAuth;
  const now = ctx.clock();
  const { mapping } = await createProvisionalPrincipal(ctx.mappings, {
    ttlMs: cfg.registrationTtlMs,
  });
  const principal: Principal = {
    id: mapping.principalId,
    state: "provisional",
    assurance: "provisional",
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  const claim = generateAgentClaimToken(ctx.config.claimPepper);
  const registration: AgentRegistration = {
    id: generateAgentRegistrationId(),
    kind: "provider_assertion",
    status: "claim_pending",
    principalId: principal.id,
    createdAt: now,
    expiresAt: new Date(now.getTime() + cfg.registrationTtlMs),
    preClaimScopes: [],
    postClaimScopes: [...cfg.postClaimScopes],
    resource: ctx.config.publicUrl,
    audience: ctx.config.issuer,
    claimEmailNormalized: verifiedEmail,
    claimTokenDigest: claim.digest,
    assertionVersion: 0,
    providerIssuer: identity.issuer,
    providerSubject: identity.subject,
    version: 1,
  };
  if (identity.clientId) {
    registration.providerClientId = identity.clientId;
  }
  try {
    await ctx.repos.transaction(async (uow) => {
      const won = await consumeProviderReplay(
        ctx,
        identity.issuer,
        identity.assertionId,
        identity.expiresAt,
        uow,
      );
      if (!won) {
        throw agentAuthError("invalid_request", 400, "assertion replayed");
      }
      await ctx.repos.principals.create(principal, uow);
      await ctx.repos.agentAuth.createRegistration(registration, uow);
    });
  } catch (error) {
    await ctx.repos.principals.deleteUnlinkedProvisional(principal.id);
    await ctx.mappings.deleteProvisional(principal.id);
    throw error;
  }
  const ceremony = await startClaimAttempt(
    ctx,
    registration,
    verifiedEmail,
    correlationId,
  );
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "agent_auth.registration.created",
    outcome: "succeeded",
    principalId: principal.id,
    correlationId,
    actorType: "agent",
    targetType: "agent_registration",
    targetId: registration.id,
    metadata: {
      type: "identity_assertion",
      action: "agent_auth.first_link",
      issuer: identity.issuer,
    },
  });
  firstLinkRequired(ctx, registration, claim, ceremony);
}
