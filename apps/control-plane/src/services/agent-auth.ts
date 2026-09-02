import { createHash } from "node:crypto";
import {
  AGENT_CLAIM_GRANT,
  JWT_BEARER_GRANT,
  SERVICE_ASSERTION_TYP,
  type ServiceAssertionKey,
  agentAuthError,
  issueServiceAgentIdentityAssertion,
  verifyServiceAgentIdentityAssertion,
} from "@opensesame/agent-protocols";
import {
  isEmailLoginHint,
  normalizeLoginHint,
} from "@opensesame/agent-protocols";
import { appendAuditEvent } from "@opensesame/audit";
import { createProvisionalPrincipal } from "@opensesame/auth-upstream";
import { ConflictError } from "@opensesame/database";
import {
  type AgentAccessTokenRecord,
  type AgentClaimAttempt,
  type AgentRegistration,
  type Principal,
  digestAgentAccessToken,
  digestAgentClaimAttemptToken,
  digestAgentClaimToken,
  digestAgentUserCode,
  generateAgentAccessToken,
  generateAgentAccessTokenId,
  generateAgentClaimAttemptId,
  generateAgentClaimAttemptToken,
  generateAgentClaimToken,
  generateAgentRegistrationId,
  generateAgentUserCode,
  hmacDigest,
  overlapCast,
  verifyAgentUserCode,
} from "@opensesame/os-domain";
import {
  claimAgentRegistration,
  markAgentRegistrationClaimPending,
  revokeAgentRegistration,
} from "@opensesame/os-domain";
import {
  DEFAULT_POST_CLAIM_SCOPES,
  DEFAULT_PRE_CLAIM_SCOPES,
  evaluateAgentAuthScopes,
  intersectAgentAuthScopes,
  scopesForRegistrationState,
} from "@opensesame/policy";
import { exportJWK, generateKeyPair } from "jose";
import type { AppContext } from "../context.js";

export interface AgentAuthRuntime {
  key: ServiceAssertionKey;
  publicKey: ServiceAssertionKey["privateKey"];
}

let runtimePromise: Promise<AgentAuthRuntime> | undefined;

export async function agentAuthRuntime(): Promise<AgentAuthRuntime> {
  runtimePromise ??= (async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", {
      extractable: true,
    });
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "os-sia-1";
    publicJwk.alg = "ES256";
    publicJwk.use = "sig";
    return {
      publicKey,
      key: {
        privateKey,
        publicJwk,
        kid: "os-sia-1",
        alg: "ES256",
      },
    };
  })();
  return runtimePromise;
}

function encodeActSubject(
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

function fingerprintOf(headers: {
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

async function mintAssertion(
  ctx: AppContext,
  registration: AgentRegistration,
  claimed: boolean,
  scopes: readonly string[],
  now: Date,
): Promise<{ jwt: string; expiresAt: Date; jti: string }> {
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
  const issued = await issueServiceAgentIdentityAssertion(key, {
    issuer: ctx.config.issuer,
    audience: ctx.config.issuer,
    registrationId: registration.id,
    claimed,
    assertionVersion: registration.assertionVersion,
    scopes,
    expiresAt,
    now,
    ...(registration.resource ? { resource: registration.resource } : {}),
    ...(actSub ? { actSub } : {}),
  });
  await ctx.repos.agentAuth.createAssertion({
    jti: issued.jti,
    registrationId: registration.id,
    assertionVersion: registration.assertionVersion,
    expiresAt,
    createdAt: now,
  });
  return { jwt: issued.jwt, expiresAt, jti: issued.jti };
}

async function mintAccessToken(
  ctx: AppContext,
  registration: AgentRegistration,
  scopes: readonly string[],
  claimed: boolean,
  now: Date,
): Promise<{ token: string; expiresAt: Date; record: AgentAccessTokenRecord }> {
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

async function loadPrincipal(ctx: AppContext, id: string): Promise<Principal> {
  const principal = await ctx.repos.principals.getById(id);
  if (!principal) {
    throw agentAuthError("invalid_grant", 400, "principal missing");
  }
  return principal;
}

function effectiveScopes(
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
  const intersected = intersectAgentAuthScopes({
    ...(requested ? { requested } : {}),
    registration: stateScopes,
    resourceSupported: ctx.config.agentAuth.resourceScopes,
  });
  const { allowed } = evaluateAgentAuthScopes(
    ctx.policy,
    principal,
    intersected,
  );
  return allowed;
}

export async function registerAnonymous(
  ctx: AppContext,
  headers: { userAgent?: string; origin?: string },
  correlationId: string,
): Promise<Record<string, unknown>> {
  const cfg = ctx.config.agentAuth;
  if (!cfg.enabled || !cfg.anonymousEnabled) {
    throw agentAuthError("anonymous_not_enabled", 400);
  }
  const now = ctx.clock();
  await ctx.repos.agentAuth.expireDue(now);
  if (
    !consumeAgentAuthMintBudget(
      ctx.stores.agentAuthMints,
      fingerprintOf(headers),
      now.getTime(),
    )
  ) {
    throw agentAuthError("rate_limited", 429);
  }
  const live = await ctx.repos.agentAuth.countLiveRegistrations();
  if (live >= cfg.maxLiveAnonymous) {
    throw agentAuthError("rate_limited", 429, "anonymous capacity exceeded");
  }

  const { mapping } = await createProvisionalPrincipal(ctx.mappings, {
    ttlMs: cfg.registrationTtlMs,
    quotaProfile: "anonymous",
    allowedActions: [
      "project.create_temporary",
      "resource.create_temporary",
      "resource.read",
      "claim.create",
      "agent.register_ephemeral",
    ],
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
    kind: "anonymous",
    status: "unclaimed",
    principalId: principal.id,
    createdAt: now,
    expiresAt: new Date(now.getTime() + cfg.registrationTtlMs),
    preClaimScopes: [...cfg.preClaimScopes],
    postClaimScopes: [...cfg.postClaimScopes],
    resource: ctx.config.publicUrl,
    audience: ctx.config.issuer,
    claimTokenDigest: claim.digest,
    assertionVersion: 1,
    version: 1,
  };

  try {
    await ctx.repos.transaction(async (uow) => {
      await ctx.repos.principals.create(principal, uow);
      await ctx.repos.agentAuth.createRegistration(registration, uow);
    });
  } catch (error) {
    await ctx.repos.principals.deleteUnlinkedProvisional(principal.id);
    await ctx.mappings.deleteProvisional(principal.id);
    throw error;
  }

  const scopes = effectiveScopes(ctx, registration, principal);
  const assertion = await mintAssertion(ctx, registration, false, scopes, now);
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "agent_auth.registration.created",
    outcome: "succeeded",
    principalId: principal.id,
    correlationId,
    actorType: "agent",
    targetType: "agent_registration",
    targetId: registration.id,
    metadata: {
      type: "anonymous",
      action: "agent_auth.register",
    },
  });

  return {
    registration_id: registration.id,
    registration_type: "anonymous",
    identity_assertion: assertion.jwt,
    assertion_expires: assertion.expiresAt.toISOString(),
    pre_claim_scopes: scopes,
    claim_url: `${ctx.config.publicUrl}/agent/identity/claim`,
    claim_token: claim.token,
    claim_token_expires: registration.expiresAt.toISOString(),
    post_claim_scopes: [...registration.postClaimScopes],
  };
}

export async function registerServiceAuth(
  ctx: AppContext,
  loginHint: string,
  headers: { userAgent?: string; origin?: string },
  correlationId: string,
): Promise<Record<string, unknown>> {
  const cfg = ctx.config.agentAuth;
  if (!cfg.enabled || !cfg.serviceAuthEnabled) {
    throw agentAuthError("service_auth_not_enabled", 400);
  }
  if (!isEmailLoginHint(loginHint)) {
    throw agentAuthError("invalid_login_hint", 400);
  }
  const now = ctx.clock();
  if (
    !consumeAgentAuthMintBudget(
      ctx.stores.agentAuthMints,
      fingerprintOf(headers),
      now.getTime(),
    )
  ) {
    throw agentAuthError("rate_limited", 429);
  }

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
    kind: "service_auth",
    status: "claim_pending",
    principalId: principal.id,
    createdAt: now,
    expiresAt: new Date(now.getTime() + cfg.registrationTtlMs),
    preClaimScopes: [],
    postClaimScopes: [...cfg.postClaimScopes],
    resource: ctx.config.publicUrl,
    audience: ctx.config.issuer,
    claimEmailNormalized: normalizeLoginHint(loginHint),
    claimTokenDigest: claim.digest,
    assertionVersion: 0,
    version: 1,
  };
  try {
    await ctx.repos.transaction(async (uow) => {
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
    registration.claimEmailNormalized,
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
    metadata: { type: "service_auth", action: "agent_auth.register" },
  });
  return {
    registration_id: registration.id,
    registration_type: "service_auth",
    claim_url: `${ctx.config.publicUrl}/agent/identity/claim`,
    claim_token: claim.token,
    claim_token_expires: registration.expiresAt.toISOString(),
    post_claim_scopes: [...registration.postClaimScopes],
    claim: ceremony.claim,
  };
}

async function startClaimAttempt(
  ctx: AppContext,
  registration: AgentRegistration,
  email: string | undefined,
  correlationId: string,
): Promise<{
  claim: {
    user_code: string;
    expires_in: number;
    verification_uri: string;
    interval: number;
  };
  attemptId: string;
  expiresAt: Date;
}> {
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

export async function initClaim(
  ctx: AppContext,
  claimToken: string,
  email: string | undefined,
  correlationId: string,
): Promise<Record<string, unknown>> {
  const digest = digestAgentClaimToken(ctx.config.claimPepper, claimToken);
  if (!digest) {
    throw agentAuthError("invalid_claim_token", 400);
  }
  const registration =
    await ctx.repos.agentAuth.getRegistrationByClaimTokenDigest(digest);
  if (!registration) {
    throw agentAuthError("invalid_claim_token", 400);
  }
  const now = ctx.clock();
  if (now >= registration.expiresAt || registration.status === "expired") {
    throw agentAuthError("claim_expired", 410);
  }
  if (registration.status === "claimed" || registration.status === "revoked") {
    throw agentAuthError("claimed_or_in_flight", 400);
  }
  const emailNormalized = email ? normalizeLoginHint(email) : undefined;
  if (email && !isEmailLoginHint(email)) {
    throw agentAuthError("invalid_login_hint", 400);
  }
  if (
    registration.kind === "service_auth" &&
    registration.claimEmailNormalized &&
    emailNormalized &&
    emailNormalized !== registration.claimEmailNormalized
  ) {
    // Same response as a matching email: do not leak whether the hint exists.
    throw agentAuthError("invalid_claim_token", 400);
  }
  const boundEmail = emailNormalized ?? registration.claimEmailNormalized;
  const ceremony = await startClaimAttempt(
    ctx,
    registration,
    boundEmail,
    correlationId,
  );
  return {
    registration_id: registration.id,
    claim_attempt_id: ceremony.attemptId,
    status: "initiated",
    expires_at: ceremony.expiresAt.toISOString(),
    claim_attempt: ceremony.claim,
  };
}

async function sessionMayClaim(
  ctx: AppContext,
  principal: Principal,
  expectedEmail?: string,
): Promise<boolean> {
  if (
    principal.assurance === "provisional" &&
    principal.state === "provisional"
  ) {
    const identities = await ctx.repos.externalIdentities.listByPrincipal(
      principal.id,
    );
    if (!identities.some((identity) => identity.emailVerified)) return false;
  }
  if (!expectedEmail) return true;
  const identities = await ctx.repos.externalIdentities.listByPrincipal(
    principal.id,
  );
  return identities.some(
    (identity) =>
      identity.emailVerified === true &&
      identity.emailNormalized === expectedEmail,
  );
}

export async function completeClaim(
  ctx: AppContext,
  principalId: string,
  claimAttemptToken: string,
  userCode: string,
  correlationId: string,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const digest = digestAgentClaimAttemptToken(
    ctx.config.claimPepper,
    claimAttemptToken,
  );
  if (!digest) {
    return { ok: false, error: "invalid_request", status: 400 };
  }
  const attempt =
    await ctx.repos.agentAuth.getClaimAttemptByTokenDigest(digest);
  if (!attempt || attempt.completedAt) {
    return { ok: false, error: "invalid_request", status: 400 };
  }
  const now = ctx.clock();
  if (now >= attempt.expiresAt) {
    return { ok: false, error: "expired_token", status: 400 };
  }
  if (attempt.failedAttempts >= ctx.config.agentAuth.maxUserCodeAttempts) {
    return { ok: false, error: "invalid_request", status: 400 };
  }
  const registration = await ctx.repos.agentAuth.getRegistrationById(
    attempt.registrationId,
  );
  if (!registration || registration.status === "claimed") {
    return { ok: false, error: "claimed_or_in_flight", status: 400 };
  }
  if (
    !verifyAgentUserCode(
      ctx.config.claimPepper,
      attempt.id,
      userCode,
      attempt.userCodeDigest,
    )
  ) {
    await ctx.repos.agentAuth.updateClaimAttempt({
      ...attempt,
      failedAttempts: attempt.failedAttempts + 1,
    });
    return { ok: false, error: "invalid_user_code", status: 400 };
  }
  const principal = await loadPrincipal(ctx, principalId);
  const expectedEmail =
    attempt.emailNormalized ?? registration.claimEmailNormalized;
  if (!(await sessionMayClaim(ctx, principal, expectedEmail))) {
    return { ok: false, error: "invalid_request", status: 400 };
  }

  try {
    await ctx.repos.transaction(async (uow) => {
      const claimed = claimAgentRegistration(registration, principal.id, now);
      await ctx.repos.agentAuth.compareAndSetRegistration(
        registration.version,
        claimed,
        uow,
      );
      await ctx.repos.agentAuth.updateClaimAttempt(
        { ...attempt, completedAt: now },
        uow,
      );
      await ctx.repos.agentAuth.revokeAccessTokensForRegistration(
        registration.id,
        now,
        true,
        uow,
      );
      await ctx.repos.agentAuth.revokeAssertionsForRegistration(
        registration.id,
        now,
        claimed.assertionVersion,
        uow,
      );
    });
  } catch (error) {
    if (error instanceof ConflictError) {
      return { ok: false, error: "claimed_or_in_flight", status: 409 };
    }
    throw error;
  }

  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "agent_auth.claim.confirmed",
    outcome: "succeeded",
    principalId: principal.id,
    correlationId,
    actorType: "human",
    targetType: "agent_registration",
    targetId: registration.id,
    metadata: { action: "agent_auth.claim_complete" },
  });
  return { ok: true };
}

export async function exchangeJwtBearer(
  ctx: AppContext,
  assertion: string,
  resource: string | undefined,
  requestedScope: string | undefined,
  correlationId: string,
): Promise<Record<string, unknown>> {
  const runtime = await agentAuthRuntime();
  const claims = await verifyServiceAgentIdentityAssertion(assertion, {
    issuer: ctx.config.issuer,
    audience: ctx.config.issuer,
    ...(resource ? { resource } : {}),
    getKey: async () => overlapCast(runtime.publicKey),
  });
  const recorded = await ctx.repos.agentAuth.getAssertionByJti(claims.jti);
  if (!recorded || recorded.revokedAt) {
    throw agentAuthError("invalid_grant", 400, "assertion revoked");
  }
  const registration = await ctx.repos.agentAuth.getRegistrationById(
    claims.sub,
  );
  if (!registration || registration.status === "revoked") {
    throw agentAuthError("invalid_grant", 400, "registration invalid");
  }
  if (registration.assertionVersion !== claims.os_av) {
    throw agentAuthError("invalid_grant", 400, "assertion superseded");
  }
  if (registration.status === "expired") {
    throw agentAuthError("invalid_grant", 400, "registration expired");
  }
  const claimed = registration.status === "claimed";
  if (claims.os_claimed !== claimed) {
    throw agentAuthError("invalid_grant", 400, "assertion claim state stale");
  }
  const principal = await loadPrincipal(ctx, registration.principalId);
  const requested = requestedScope
    ? requestedScope.split(/[\s+]+/).filter(Boolean)
    : undefined;
  const scopes = effectiveScopes(ctx, registration, principal, requested);
  const now = ctx.clock();
  const access = await mintAccessToken(ctx, registration, scopes, claimed, now);
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "agent_auth.token.issued",
    outcome: "succeeded",
    principalId: principal.id,
    correlationId,
    actorType: "agent",
    targetType: "agent_registration",
    targetId: registration.id,
    metadata: { action: "agent_auth.token_issue", type: JWT_BEARER_GRANT },
  });
  return {
    access_token: access.token,
    token_type: "Bearer",
    expires_in: Math.floor(ctx.config.agentAuth.accessTokenTtlMs / 1000),
    scope: scopes.join(" "),
  };
}

export async function pollClaimGrant(
  ctx: AppContext,
  claimToken: string,
  correlationId: string,
): Promise<Record<string, unknown>> {
  const digest = digestAgentClaimToken(ctx.config.claimPepper, claimToken);
  if (!digest) {
    throw agentAuthError("expired_token", 400, "invalid claim token");
  }
  const registration =
    await ctx.repos.agentAuth.getRegistrationByClaimTokenDigest(digest);
  if (!registration) {
    throw agentAuthError("expired_token", 400);
  }
  const now = ctx.clock();
  const attempt = await ctx.repos.agentAuth.latestClaimAttempt(registration.id);
  if (attempt) {
    if (
      attempt.slowdownUntil &&
      now.getTime() < attempt.slowdownUntil.getTime()
    ) {
      throw agentAuthError("slow_down", 400);
    }
    const minInterval = attempt.intervalSeconds * 1000;
    if (attempt.pollCount > 0) {
      const since = now.getTime() - attempt.createdAt.getTime();
      // Approximate last-poll spacing from pollCount.
      if (since / attempt.pollCount < minInterval) {
        await ctx.repos.agentAuth.updateClaimAttempt({
          ...attempt,
          pollCount: attempt.pollCount + 1,
          slowdownUntil: new Date(now.getTime() + minInterval + 5_000),
        });
        throw agentAuthError("slow_down", 400);
      }
    }
    await ctx.repos.agentAuth.updateClaimAttempt({
      ...attempt,
      pollCount: attempt.pollCount + 1,
    });
    if (now >= attempt.expiresAt && registration.status !== "claimed") {
      throw agentAuthError("expired_token", 400);
    }
  }
  if (registration.status !== "claimed") {
    throw agentAuthError("authorization_pending", 400);
  }
  const principal = await loadPrincipal(ctx, registration.principalId);
  const scopes = effectiveScopes(ctx, registration, principal);
  const assertion = await mintAssertion(ctx, registration, true, scopes, now);
  const access = await mintAccessToken(ctx, registration, scopes, true, now);
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "agent_auth.token.issued",
    outcome: "succeeded",
    principalId: principal.id,
    correlationId,
    actorType: "agent",
    targetType: "agent_registration",
    targetId: registration.id,
    metadata: { action: "agent_auth.token_issue", type: AGENT_CLAIM_GRANT },
  });
  return {
    access_token: access.token,
    token_type: "Bearer",
    expires_in: Math.floor(ctx.config.agentAuth.accessTokenTtlMs / 1000),
    scope: scopes.join(" "),
    identity_assertion: assertion.jwt,
    assertion_expires: assertion.expiresAt.toISOString(),
  };
}

export async function revokeAccessToken(
  ctx: AppContext,
  token: string,
  correlationId: string,
): Promise<void> {
  const digest = digestAgentAccessToken(ctx.config.claimPepper, token);
  if (!digest) return;
  const record = await ctx.repos.agentAuth.getAccessTokenByDigest(digest);
  if (!record || record.revokedAt) return;
  await ctx.repos.agentAuth.revokeAccessToken(record.id, ctx.clock());
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "agent_auth.token.revoked",
    outcome: "succeeded",
    correlationId,
    actorType: "agent",
    targetType: "agent_registration",
    targetId: record.registrationId,
    metadata: { action: "agent_auth.token_revoke" },
  });
}

export async function revokeRegistration(
  ctx: AppContext,
  principalId: string,
  registrationId: string,
  correlationId: string,
): Promise<void> {
  const registration =
    await ctx.repos.agentAuth.getRegistrationById(registrationId);
  if (!registration) return;
  const owner = registration.claimedByPrincipalId ?? registration.principalId;
  if (owner !== principalId) {
    throw agentAuthError("invalid_request", 403, "not the registration owner");
  }
  const now = ctx.clock();
  const revoked = revokeAgentRegistration(registration, now);
  await ctx.repos.transaction(async (uow) => {
    await ctx.repos.agentAuth.compareAndSetRegistration(
      registration.version,
      revoked,
      uow,
    );
    await ctx.repos.agentAuth.revokeAccessTokensForRegistration(
      registration.id,
      now,
      false,
      uow,
    );
    await ctx.repos.agentAuth.revokeAssertionsForRegistration(
      registration.id,
      now,
      undefined,
      uow,
    );
  });
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "agent_auth.registration.revoked",
    outcome: "succeeded",
    principalId,
    correlationId,
    actorType: "human",
    targetType: "agent_registration",
    targetId: registration.id,
    metadata: { action: "agent_auth.registration_revoke" },
  });
}

export async function resolveAgentAccessToken(
  ctx: AppContext,
  token: string,
): Promise<{
  registration: AgentRegistration;
  scopes: string[];
  claimed: boolean;
} | null> {
  const digest = digestAgentAccessToken(ctx.config.claimPepper, token);
  if (!digest) return null;
  const record = await ctx.repos.agentAuth.getAccessTokenByDigest(digest);
  if (!record || record.revokedAt || record.expiresAt <= ctx.clock()) {
    return null;
  }
  const registration = await ctx.repos.agentAuth.getRegistrationById(
    record.registrationId,
  );
  if (!registration || registration.status === "revoked") return null;
  return {
    registration,
    scopes: record.scopes,
    claimed: record.claimed,
  };
}
