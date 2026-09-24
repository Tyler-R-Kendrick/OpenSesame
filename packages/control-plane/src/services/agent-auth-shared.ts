import { createHash } from "node:crypto";
import {
  agentAuthError,
  issueServiceAgentIdentityAssertion,
} from "@opensesame/agent-protocols";
import { appendAuditEvent } from "@opensesame/audit";
import {
  type AgentAccessTokenRecord,
  type AgentClaimAttempt,
  type AgentRegistration,
  type Principal,
  digestAgentAccessToken,
  digestAgentClaimAttemptToken,
  digestAgentUserCode,
  generateAgentAccessToken,
  generateAgentAccessTokenId,
  generateAgentClaimAttemptId,
  generateAgentClaimAttemptToken,
  generateAgentUserCode,
  hmacDigest,
  verifyAgentUserCode,
} from "@opensesame/os-domain";
import { markAgentRegistrationClaimPending } from "@opensesame/os-domain";
import {
  evaluateAgentAuthScopes,
  intersectAgentAuthScopes,
  scopesForRegistrationState,
} from "@opensesame/policy";
import type { AppContext } from "../context.js";
import { agentAuthRuntime } from "./agent-auth-runtime.js";

export function encodeActSubject(
  pepper: string,
  sector: string,
  principalId: string,
): string {
  const digest = hmacDigest(
    pepper,
    "opensesame:agent-auth:act:v1",
    sector,
    principalId,
  );
  return `osact_${Buffer.from(digest).toString("base64url")}`;
}

export function fingerprintOf(headers: {
  userAgent?: string;
  origin?: string;
}): string {
  return createHash("sha256")
    .update(headers.userAgent ?? "")
    .update("|")
    .update(headers.origin ?? "")
    .digest("hex")
    .slice(0, 16);
}

export function consumeAgentAuthMintBudget(
  map: Map<string, number[]>,
  fingerprint: string,
  now: number,
): boolean {
  const windowMs = 60_000;
  const perClient = 8;
  const global = 80;
  for (const [key, values] of map) {
    const live = values.filter((at) => now - at < windowMs);
    if (live.length === 0) map.delete(key);
    else if (live.length !== values.length) map.set(key, live);
  }
  const g = map.get("__global__") ?? [];
  const c = map.get(fingerprint) ?? [];
  if (g.length >= global || c.length >= perClient) return false;
  g.push(now);
  c.push(now);
  map.set("__global__", g);
  map.set(fingerprint, c);
  return true;
}

export async function mintAssertion(
  ctx: AppContext,
  registration: AgentRegistration,
  claimed: boolean,
  scopes: readonly string[],
  now: Date,
) {
  const { key } = await agentAuthRuntime();
  const expiresAt = new Date(
    now.getTime() + ctx.config.agentAuth.assertionTtlMs,
  );
  const actSub =
    claimed && registration.claimedByPrincipalId
      ? encodeActSubject(
          ctx.config.claimPepper,
          registration.resource ?? ctx.config.issuer,
          registration.claimedByPrincipalId,
        )
      : undefined;
  const input: Parameters<typeof issueServiceAgentIdentityAssertion>[1] = {
    issuer: ctx.config.issuer,
    audience: ctx.config.issuer,
    registrationId: registration.id,
    claimed,
    assertionVersion: registration.assertionVersion,
    scopes,
    expiresAt,
    now,
  };
  if (registration.resource) input.resource = registration.resource;
  if (actSub) input.actSub = actSub;
  const issued = await issueServiceAgentIdentityAssertion(key, input);
  await ctx.repos.agentAuth.createAssertion({
    jti: issued.jti,
    registrationId: registration.id,
    assertionVersion: registration.assertionVersion,
    expiresAt,
    createdAt: now,
  });
  return { jwt: issued.jwt, expiresAt, jti: issued.jti };
}

export async function mintAccessToken(
  ctx: AppContext,
  registration: AgentRegistration,
  scopes: readonly string[],
  claimed: boolean,
  now: Date,
) {
  const generated = generateAgentAccessToken(ctx.config.claimPepper);
  const expiresAt = new Date(
    now.getTime() + ctx.config.agentAuth.accessTokenTtlMs,
  );
  const record: AgentAccessTokenRecord = {
    id: generateAgentAccessTokenId(),
    registrationId: registration.id,
    tokenDigest: generated.digest,
    scopes: [...scopes],
    claimed,
    assertionVersion: registration.assertionVersion,
    expiresAt,
    createdAt: now,
  };
  if (registration.resource) record.resource = registration.resource;
  await ctx.repos.agentAuth.createAccessToken(record);
  return { token: generated.token, expiresAt, record };
}

export async function expireAndLoadRegistration(
  ctx: AppContext,
  id: string,
): Promise<AgentRegistration | null> {
  const now = ctx.clock();
  await ctx.repos.agentAuth.expireDue(now);
  const registration = await ctx.repos.agentAuth.getRegistrationById(id);
  if (!registration) return null;
  if (registration.status === "revoked" || registration.status === "expired") {
    return null;
  }
  if (
    (registration.status === "unclaimed" ||
      registration.status === "claim_pending") &&
    now >= registration.expiresAt
  ) {
    return null;
  }
  return registration;
}

export async function loadPrincipal(
  ctx: AppContext,
  id: string,
): Promise<Principal> {
  const principal = await ctx.repos.principals.getById(id);
  if (!principal) {
    throw agentAuthError("invalid_grant", 400, "principal missing");
  }
  return principal;
}

export function effectiveScopes(
  ctx: AppContext,
  registration: AgentRegistration,
  principal: Principal,
  requested?: readonly string[],
): string[] {
  const stateScopes = scopesForRegistrationState({
    claimed: registration.status === "claimed",
    preClaimScopes: registration.preClaimScopes,
    postClaimScopes: registration.postClaimScopes,
  });
  const parts: Parameters<typeof intersectAgentAuthScopes>[0] = {
    registration: stateScopes,
    resourceSupported: ctx.config.agentAuth.resourceScopes,
  };
  if (requested) parts.requested = requested;
  const intersected = intersectAgentAuthScopes(parts);
  const { allowed } = evaluateAgentAuthScopes(
    ctx.policy,
    principal,
    intersected,
  );
  return allowed;
}

export async function startClaimAttempt(
  ctx: AppContext,
  registration: AgentRegistration,
  email: string | undefined,
  correlationId: string,
) {
  const now = ctx.clock();
  const cfg = ctx.config.agentAuth;
  const attemptToken = generateAgentClaimAttemptToken(ctx.config.claimPepper);
  const userCode = generateAgentUserCode();
  const attemptId = generateAgentClaimAttemptId();
  const expiresAt = new Date(now.getTime() + cfg.claimAttemptTtlMs);
  const attempt: AgentClaimAttempt = {
    id: attemptId,
    registrationId: registration.id,
    attemptTokenDigest: attemptToken.digest,
    userCodeDigest: digestAgentUserCode(
      ctx.config.claimPepper,
      attemptId,
      userCode,
    ),
    createdAt: now,
    expiresAt,
    intervalSeconds: cfg.pollIntervalSeconds,
    pollCount: 0,
    failedAttempts: 0,
  };
  if (email) attempt.emailNormalized = email;
  await ctx.repos.agentAuth.createClaimAttempt(attempt);
  if (registration.status === "unclaimed") {
    const pending = markAgentRegistrationClaimPending(registration, now);
    await ctx.repos.agentAuth.compareAndSetRegistration(
      registration.version,
      pending,
    );
  }
  const returnTo = `/claim?claim_attempt_token=${encodeURIComponent(attemptToken.token)}`;
  const verificationUri = `${ctx.config.publicUrl}/login?return_to=${encodeURIComponent(returnTo)}`;
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "agent_auth.claim.requested",
    outcome: "succeeded",
    principalId: registration.principalId,
    correlationId,
    actorType: "agent",
    targetType: "agent_registration",
    targetId: registration.id,
    metadata: { action: "agent_auth.claim_start" },
  });
  return {
    attemptId,
    expiresAt,
    claim: {
      user_code: userCode,
      expires_in: Math.floor(cfg.claimAttemptTtlMs / 1000),
      verification_uri: verificationUri,
      interval: cfg.pollIntervalSeconds,
    },
  };
}
