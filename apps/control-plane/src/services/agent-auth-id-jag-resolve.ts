import { randomUUID } from "node:crypto";
import {
  type VerifiedProviderIdentity,
  agentAuthError,
  normalizeLoginHint,
} from "@opensesame/agent-protocols";
import {
  type AgentRegistration,
  type ExternalIdentity,
  type Principal,
  generateAgentRegistrationId,
} from "@opensesame/os-domain";
import type { AppContext } from "../context.js";

type BuiltProviderRegistration = {
  registration: AgentRegistration;
  principalId: string;
  principal: Principal;
};

function buildProviderRegistration(
  ctx: AppContext,
  identity: VerifiedProviderIdentity,
  principalIdIn: string | undefined,
  principalIn: Principal | null,
  now: Date,
) {
  const cfg = ctx.config.agentAuth;
  let principalId = principalIdIn;
  let principal = principalIn;
  const registration: AgentRegistration = {
    id: generateAgentRegistrationId(),
    kind: "provider_assertion",
    status: "claimed",
    principalId: principalId ?? `prn_${randomUUID()}`,
    createdAt: now,
    expiresAt: new Date(now.getTime() + cfg.registrationTtlMs),
    claimedAt: now,
    preClaimScopes: [],
    postClaimScopes: [...cfg.postClaimScopes],
    resource: ctx.config.publicUrl,
    audience: ctx.config.issuer,
    assertionVersion: 1,
    providerIssuer: identity.issuer,
    providerSubject: identity.subject,
    version: 1,
  };
  if (principalId) {
    registration.claimedByPrincipalId = principalId;
  }
  if (identity.clientId) {
    registration.providerClientId = identity.clientId;
  }
  if (!principalId) {
    principalId = registration.principalId;
    registration.claimedByPrincipalId = principalId;
    principal = {
      id: principalId,
      state: "active",
      assurance: "verified",
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
  } else if (principal) {
    registration.principalId = principal.id;
    registration.claimedByPrincipalId = principal.id;
  }

  if (!principal || !principalId) {
    throw agentAuthError("invalid_request", 400, "principal unavailable");
  }
  return { registration, principalId, principal };
}

type ResolvedProviderRegistration = {
  principal: Principal;
  registration: AgentRegistration;
  existing: ExternalIdentity | null;
  identityRow: ExternalIdentity | null;
  now: Date;
};

export async function resolveProviderRegistration(
  ctx: AppContext,
  identity: VerifiedProviderIdentity,
  correlationId: string,
  beginProviderFirstLink: (
    ctx: AppContext,
    identity: VerifiedProviderIdentity,
    verifiedEmail: string,
    correlationId: string,
  ) => Promise<never>,
): Promise<ResolvedProviderRegistration> {
  const now = ctx.clock();
  const existing = await ctx.repos.externalIdentities.findByTuple({
    kind: "auth_md",
    issuer: identity.issuer,
    subject: identity.subject,
  });

  const verifiedEmail =
    identity.emailVerified && identity.email
      ? normalizeLoginHint(identity.email)
      : undefined;
  if (!existing && verifiedEmail) {
    const peer =
      await ctx.repos.externalIdentities.findVerifiedByEmail(verifiedEmail);
    if (peer) {
      return beginProviderFirstLink(
        ctx,
        identity,
        verifiedEmail,
        correlationId,
      );
    }
  }

  const principalId = existing?.principalId;
  const principal = principalId
    ? await ctx.repos.principals.getById(principalId)
    : null;

  const built = buildProviderRegistration(
    ctx,
    identity,
    principalId,
    principal,
    now,
  );
  let identityRow: ExternalIdentity | null = null;
  if (!existing) {
    identityRow = {
      id: `xid_${randomUUID()}`,
      principalId: built.principal.id,
      kind: "auth_md",
      issuer: identity.issuer,
      subject: identity.subject,
      assurance: "verified",
      linkedAt: now,
      metadata: {},
    };
    if (verifiedEmail) {
      identityRow.emailNormalized = verifiedEmail;
    }
    if (identity.emailVerified) {
      identityRow.emailVerified = true;
    }
  }

  return {
    principal: built.principal,
    registration: built.registration,
    existing,
    identityRow,
    now,
  };
}
