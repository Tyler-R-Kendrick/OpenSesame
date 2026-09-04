import { createHash, randomUUID } from "node:crypto";
import {
  AGENT_CLAIM_GRANT,
  ID_JAG_ASSERTION_TYPE,
  JWT_BEARER_GRANT,
  type ServiceAssertionKey,
  agentAuthError,
  isEmailLoginHint,
  issueServiceAgentIdentityAssertion,
  normalizeLoginHint,
  verifyProviderIdJag,
  verifyServiceAgentIdentityAssertion,
} from "@opensesame/agent-protocols";
import { appendAuditEvent } from "@opensesame/audit";
import { createProvisionalPrincipal } from "@opensesame/auth-upstream";
import { ConflictError, type UnitOfWork } from "@opensesame/database";
import { assertSafeMetadataUrl } from "@opensesame/oauth-provider";
import {
  type AgentAccessTokenRecord,
  type AgentClaimAttempt,
  type AgentRegistration,
  type ExternalIdentity,
  type JsonObject,
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
  evaluateAgentAuthScopes,
  intersectAgentAuthScopes,
  scopesForRegistrationState,
} from "@opensesame/policy";
import { exportJWK, generateKeyPair, importJWK } from "jose";
import type { JWK } from "jose";
import type { AgentAuthTrustedProvider } from "../config.js";
import type { AppContext } from "../context.js";

export interface AgentAuthRuntime {
  key: ServiceAssertionKey;
  publicKey: ServiceAssertionKey["privateKey"];
}

let runtimePromise: Promise<AgentAuthRuntime> | undefined;

export async function agentAuthRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentAuthRuntime> {
  runtimePromise ??= loadAgentAuthRuntime(env);
  return runtimePromise;
}

export function resetAgentAuthRuntimeForTests(): void {
  runtimePromise = undefined;
}

async function loadAgentAuthRuntime(
  env: NodeJS.ProcessEnv,
): Promise<AgentAuthRuntime> {
  const fromEnv = await runtimeFromJwksEnv(env);
  if (fromEnv) return fromEnv;
  const isProduction =
    env.NODE_ENV === "production" || env.OPENSESAME_ENV === "production";
  if (isProduction) {
    throw new Error(
      "AgentAuth service assertion signing keys are required in production — set OPENSESAME_JWKS_JSON or OPENSESAME_AGENT_AUTH_SIA_JWK",
    );
  }
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
}

async function runtimeFromJwksEnv(
  env: NodeJS.ProcessEnv,
): Promise<AgentAuthRuntime | undefined> {
  const single = env.OPENSESAME_AGENT_AUTH_SIA_JWK;
  const set = env.OPENSESAME_JWKS_JSON;
  const raw = single ?? set;
  if (!raw) return undefined;
  let keys: JWK[] = [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (single) {
      keys = [parsed as JWK];
    } else {
      const obj = parsed as { keys?: JWK[] };
      keys = Array.isArray(obj.keys) ? obj.keys : [];
    }
  } catch {
    throw new Error("AgentAuth signing JWKS is not valid JSON");
  }
  const chosen =
    keys.find((key) => key.kid === "os-sia-1" && key.d) ??
    keys.find((key) => (key.alg === "ES256" || key.alg === "RS256") && key.d);
  if (!chosen || !chosen.d) return undefined;
  const alg = chosen.alg === "RS256" ? "RS256" : "ES256";
  const privateKey = await importJWK(chosen, alg);
  const {
    d: _d,
    p: _p,
    q: _q,
    dp: _dp,
    dq: _dq,
    qi: _qi,
    ...publicJwk
  } = chosen;
  publicJwk.kid = chosen.kid ?? "os-sia-1";
  publicJwk.alg = alg;
  publicJwk.use = "sig";
  return {
    publicKey: privateKey,
    key: {
      privateKey,
      publicJwk,
      kid: String(publicJwk.kid),
      alg,
    },
  };
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

async function expireAndLoadRegistration(
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

export function providerAssertionIsAdvertised(
  cfg: AppContext["config"]["agentAuth"],
): boolean {
  return (
    cfg.enabled &&
    cfg.providerAssertionEnabled &&
    cfg.trustedProviders.some((provider) => provider.enabled)
  );
}

const providerReplayFallback = new Map<string, number>();

async function consumeProviderReplay(
  ctx: AppContext,
  issuer: string,
  jti: string,
  expiresAt: Date,
  uow?: UnitOfWork,
): Promise<boolean> {
  const consume = ctx.repos.agentAuth.consumeProviderAssertionReplay;
  if (typeof consume === "function") {
    return consume(issuer, jti, expiresAt, uow);
  }
  const key = `${issuer}\0${jti}`;
  const now = Date.now();
  for (const [seen, exp] of providerReplayFallback) {
    if (exp <= now) providerReplayFallback.delete(seen);
  }
  if (providerReplayFallback.has(key)) return false;
  providerReplayFallback.set(key, expiresAt.getTime());
  return true;
}

function trustedProviderFor(
  cfg: AppContext["config"]["agentAuth"],
  issuer: string,
): AgentAuthTrustedProvider | undefined {
  const normalized = issuer.replace(/\/+$/u, "");
  return cfg.trustedProviders.find(
    (provider) =>
      provider.enabled && provider.issuer.replace(/\/+$/u, "") === normalized,
  );
}

async function jwksForProvider(
  provider: AgentAuthTrustedProvider,
): Promise<{ keys: JsonObject[] }> {
  if (provider.jwks?.keys && provider.jwks.keys.length > 0) {
    return provider.jwks;
  }
  if (!provider.jwksUri) {
    throw agentAuthError("invalid_request", 400, "provider keys unavailable");
  }
  try {
    assertSafeMetadataUrl(provider.jwksUri);
  } catch {
    throw agentAuthError(
      "invalid_request",
      400,
      "provider jwks_uri is not safe",
    );
  }
  const response = await fetch(provider.jwksUri, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw agentAuthError("invalid_request", 400, "provider JWKS fetch failed");
  }
  const body = await response.text();
  if (body.length > 65_536) {
    throw agentAuthError("invalid_request", 400, "provider JWKS too large");
  }
  let parsed: { keys?: JsonObject[] };
  try {
    parsed = overlapCast(JSON.parse(body));
  } catch {
    throw agentAuthError("invalid_request", 400, "provider JWKS is not JSON");
  }
  if (!Array.isArray(parsed.keys) || parsed.keys.length === 0) {
    throw agentAuthError("invalid_request", 400, "provider JWKS has no keys");
  }
  return { keys: parsed.keys };
}

export async function registerProviderAssertion(
  ctx: AppContext,
  input: { assertionType: string; assertion: string },
  headers: { userAgent?: string; origin?: string },
  correlationId: string,
): Promise<Record<string, unknown>> {
  const cfg = ctx.config.agentAuth;
  if (!providerAssertionIsAdvertised(cfg)) {
    throw agentAuthError("identity_assertion_not_enabled", 400);
  }
  if (input.assertionType !== ID_JAG_ASSERTION_TYPE) {
    throw agentAuthError("invalid_request", 400, "unsupported assertion_type");
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

  let issuerHint = "";
  try {
    const payloadB64 = input.assertion.split(".")[1];
    if (payloadB64) {
      const payload = JSON.parse(
        Buffer.from(payloadB64, "base64url").toString("utf8"),
      ) as { iss?: unknown };
      if (typeof payload.iss === "string") issuerHint = payload.iss;
    }
  } catch {
    throw agentAuthError("invalid_grant", 400, "assertion is not a JWT");
  }
  const provider = trustedProviderFor(cfg, issuerHint);
  if (!provider) {
    throw agentAuthError(
      "issuer_not_enabled",
      400,
      "untrusted assertion issuer",
    );
  }
  const jwks = await jwksForProvider(provider);
  const identity = await verifyProviderIdJag(input.assertion, {
    issuer: provider.issuer,
    audiences: provider.audiences,
    algorithms: provider.algorithms,
    maxAgeSeconds: provider.maxAgeSeconds,
    maxAuthAgeSeconds: provider.maxAuthAgeSeconds,
    now,
    getKey: async (header) => {
      const listed = jwks.keys;
      const match = header.kid
        ? listed.find((key) => key.kid === header.kid)
        : listed[0];
      if (!match) {
        throw agentAuthError("invalid_request", 400, "unknown assertion kid");
      }
      try {
        return await importJWK(overlapCast(match), header.alg ?? "ES256");
      } catch {
        throw agentAuthError(
          "invalid_request",
          400,
          "assertion key import failed",
        );
      }
    },
  });

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

  let principalId = existing?.principalId;
  let principal: Principal | null = principalId
    ? await ctx.repos.principals.getById(principalId)
    : null;

  const registration: AgentRegistration = {
    id: generateAgentRegistrationId(),
    kind: "provider_assertion",
    status: "claimed",
    principalId: principalId ?? `prn_${randomUUID()}`,
    claimedByPrincipalId: principalId ?? undefined,
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
    providerClientId: identity.clientId,
    version: 1,
  };
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

  if (!principal) {
    throw agentAuthError("invalid_request", 400, "principal unavailable");
  }

  const identityRow: ExternalIdentity | null = existing
    ? null
    : {
        id: `xid_${randomUUID()}`,
        principalId: principal.id,
        kind: "auth_md",
        issuer: identity.issuer,
        subject: identity.subject,
        assurance: "verified",
        linkedAt: now,
        metadata: {},
        ...(verifiedEmail ? { emailNormalized: verifiedEmail } : {}),
        ...(identity.emailVerified ? { emailVerified: true } : {}),
      };

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
      if (!existing) {
        await ctx.repos.principals.create(principal, uow);
        if (identityRow) {
          await ctx.repos.externalIdentities.create(identityRow, uow);
        }
      }
      await ctx.repos.agentAuth.createRegistration(registration, uow);
    });
  } catch (error) {
    if (error instanceof ConflictError) {
      throw agentAuthError("invalid_request", 400, "registration conflict");
    }
    throw error;
  }

  const scopes = effectiveScopes(ctx, registration, principal);
  const assertion = await mintAssertion(ctx, registration, true, scopes, now);
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
      action: "agent_auth.register",
      issuer: identity.issuer,
    },
  });

  return {
    registration_id: registration.id,
    registration_type: "identity_assertion",
    identity_assertion: assertion.jwt,
    assertion_expires: assertion.expiresAt.toISOString(),
    scopes,
  };
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
    providerClientId: identity.clientId,
    version: 1,
  };
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
      claim: ceremony.claim,
    },
  );
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
  const found =
    await ctx.repos.agentAuth.getRegistrationByClaimTokenDigest(digest);
  if (!found) {
    throw agentAuthError("invalid_claim_token", 400);
  }
  const now = ctx.clock();
  await ctx.repos.agentAuth.expireDue(now);
  const registration = await ctx.repos.agentAuth.getRegistrationById(found.id);
  if (!registration) {
    throw agentAuthError("invalid_claim_token", 400);
  }
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
      if (
        registration.kind === "provider_assertion" &&
        registration.providerIssuer &&
        registration.providerSubject
      ) {
        const linked = await ctx.repos.externalIdentities.findByTuple({
          kind: "auth_md",
          issuer: registration.providerIssuer,
          subject: registration.providerSubject,
        });
        if (linked && linked.principalId !== principal.id) {
          throw new ConflictError("provider identity already bound");
        }
        if (!linked) {
          const row: ExternalIdentity = {
            id: `xid_${randomUUID()}`,
            principalId: principal.id,
            kind: "auth_md",
            issuer: registration.providerIssuer,
            subject: registration.providerSubject,
            assurance: "verified",
            linkedAt: now,
            metadata: {},
          };
          if (expectedEmail) {
            row.emailNormalized = expectedEmail;
            row.emailVerified = true;
          }
          await ctx.repos.externalIdentities.create(row, uow);
        }
      }
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
  const registration = await expireAndLoadRegistration(ctx, claims.sub);
  if (!registration) {
    throw agentAuthError("invalid_grant", 400, "registration invalid");
  }
  if (registration.assertionVersion !== claims.os_av) {
    throw agentAuthError("invalid_grant", 400, "assertion superseded");
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
  const found =
    await ctx.repos.agentAuth.getRegistrationByClaimTokenDigest(digest);
  if (!found) {
    throw agentAuthError("expired_token", 400);
  }
  const registration = await expireAndLoadRegistration(ctx, found.id);
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
  const registration = await expireAndLoadRegistration(
    ctx,
    record.registrationId,
  );
  if (!registration) return null;
  return {
    registration,
    scopes: record.scopes,
    claimed: record.claimed,
  };
}
