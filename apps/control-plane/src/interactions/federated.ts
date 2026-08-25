import { appendAuditEvent } from "@opensesame/audit";
import { overlapCast } from "@opensesame/os-domain";
import * as client from "openid-client";
import { z } from "zod";
import type { ControlPlaneConfig } from "../config.js";
import type { AppContext } from "../context.js";
import {
  type VerifiedOrgIdToken,
  verifyOrgIdToken,
} from "../routes/org-assertion.js";
import { mintAppleClientSecret } from "./apple-secret.js";
import type { OidcProviderDescriptor } from "./registry.js";
import { type TrustResolution, resolveTrustedIssuer } from "./trust.js";

/**
 * Server-side OIDC relying-party leg for the hosted login page (ADR 0033 §4).
 *
 * The Pages PWA federates in the browser, but the hosted `/interaction/:uid`
 * login page is server-rendered under a CSP that forbids inline script, so it
 * cannot run the browser flow. This module is the equivalent leg for that
 * surface: discovery, PKCE S256, state and nonce, then a server-side code
 * exchange whose verified claims feed the same
 * `attachVerifiedExternalIdentity` used by `POST /v1/principals/link-identities`.
 *
 * Trust is no longer a membership test against one CSV: `resolveTrustedIssuer`
 * (`./trust.ts`, ADR 0055) answers *who* vouches for an issuer — the static
 * registry, a bring-your-own record, or an organization — and the answer
 * decides how we authenticate to it. That is the same question the leg used to
 * answer twice (allowlist, then credentials-for-issuer) and now answers once.
 *
 * Protocol work is delegated to panva `openid-client` rather than hand-rolled
 * (ADR 0008). Better Auth is deliberately NOT used here: its social-provider
 * mapping silently drops providers with no client secret — which is every
 * broker in the origin-profile contract.
 */

/** An allowlisted upstream, as offered on the hosted login page. */
export type FederatedUpstream = {
  /** Stable id used to match the SDK's `kc_idp_hint` / `login_hint_provider`. */
  id: string;
  issuer: string;
  /** What the button says: "Sign in with {label}". */
  label: string;
};

/**
 * The per-interaction leg state. Travels in an httpOnly cookie scoped to
 * `/interaction/<uid>` rather than server memory, so the leg survives a
 * restart and does not pin a user to one node. It needs no signing: the
 * callback rejects unless the upstream echoes a `state` byte-equal to the one
 * in this cookie, so a forged cookie can only invalidate the attacker's own
 * flow. The verifier is single-use and the cookie is deleted on the callback.
 *
 * Everything past `verifier` is v2 (C3) and OPTIONAL by contract: a cookie
 * written by the previous release is in flight in somebody's browser while a
 * new one boots, and a required field would strand them mid-sign-in. Absent
 * `kind` means `"oidc"`, which is exactly what those cookies are.
 */
export type PendingFederatedAuth = {
  issuer: string;
  state: string;
  nonce: string;
  verifier: string;
  /** Which leg completes this: the OIDC one here, or the generic OAuth2 one. */
  kind?: "oidc" | "oauth2";
  /** Registry id, when the leg started from a catalog button. */
  providerId?: string;
  /** `byo_upstreams` id, when the visitor registered their own issuer. */
  byoId?: string;
  /** Organization id, when this is org sign-in — JIT-joined on completion. */
  orgId?: string;
};

const pendingFederatedAuthSchema = z.object({
  issuer: z.string(),
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
  kind: z.enum(["oidc", "oauth2"]).optional(),
  providerId: z.string().optional(),
  byoId: z.string().optional(),
  orgId: z.string().optional(),
});

export type FederatedAuthStart = {
  authorizationUrl: string;
  pending: PendingFederatedAuth;
};

/** Verified upstream claims. `subject` is already pairwise-resolved. */
export type FederatedIdentity = {
  /** Which leg vouched for this — recorded on the identity row (C5). */
  kind: "oidc" | "oauth2";
  issuer: string;
  subject: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
};

export type FederatedAuthErrorCode =
  | "untrusted_issuer"
  | "discovery_failed"
  | "exchange_failed"
  | "missing_subject";

export class FederatedAuthError extends Error {
  override readonly name = "FederatedAuthError";
  readonly code: FederatedAuthErrorCode;

  constructor(
    code: FederatedAuthErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
  }
}

const MOCK_UPSTREAM_LABEL = "a local test account";
const DEFAULT_OIDC_SCOPES = "openid email profile";

function issuerHost(issuer: string): string {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}

function isLoopback(issuer: string): boolean {
  const host = issuerHost(issuer).split(":")[0];
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

/**
 * Label and id for an allowlisted issuer. Mirrors the Pages `TRUSTED_UPSTREAMS`
 * table (`apps/pages/src/lib/federation.ts`) so both surfaces name the same
 * broker the same way — shoo.dev fronts Google, so its button says Google.
 */
function describeUpstream(issuer: string): FederatedUpstream {
  if (issuer === "https://shoo.dev") {
    return { id: "shoo", issuer, label: "Google" };
  }
  if (isLoopback(issuer)) {
    return { id: "mock", issuer, label: MOCK_UPSTREAM_LABEL };
  }
  return { id: issuerHost(issuer), issuer, label: issuerHost(issuer) };
}

/**
 * The allowlist as upstream descriptions. The hosted login page renders the
 * richer registry view (`staticProviders`, ADR 0055) instead; this stays as
 * the plain allowlist projection the config surface and its tests describe.
 */
export function federatedUpstreams(
  config: ControlPlaneConfig,
): FederatedUpstream[] {
  return config.trustedUpstreamIssuers.map(describeUpstream);
}

/**
 * Resolve a provider hint (`kc_idp_hint` / `login_hint_provider`) to an
 * allowlisted issuer. Matches id, issuer, host, or label, case-insensitively.
 * An unknown hint resolves to undefined and is ignored — never echoed.
 *
 * The login page uses `matchProviderHint` (`./handlers.ts`), which applies the
 * frozen id > issuer > host > label precedence over registry descriptors.
 */
export function matchUpstreamHint(
  upstreams: FederatedUpstream[],
  hint: string | undefined,
): FederatedUpstream | undefined {
  if (!hint) return undefined;
  const needle = hint.trim().toLowerCase();
  if (!needle) return undefined;
  return upstreams.find(
    (u) =>
      u.id.toLowerCase() === needle ||
      u.issuer.toLowerCase() === needle ||
      issuerHost(u.issuer).toLowerCase() === needle ||
      u.label.toLowerCase() === needle,
  );
}

export function isTrustedUpstream(
  config: ControlPlaneConfig,
  issuer: string,
): boolean {
  return config.trustedUpstreamIssuers.includes(issuer);
}

function siteOrigin(config: ControlPlaneConfig): string {
  return new URL(config.publicUrl).origin;
}

/**
 * Origin-profile client id (ADR 0034): derived from our own origin, never
 * registered with the broker and never secret-bearing.
 */
function originClientId(config: ControlPlaneConfig): string {
  return `origin:${siteOrigin(config)}`;
}

/**
 * How we authenticate to a given upstream.
 *
 * `originProfile` is the load-bearing field (T10). It is true for exactly one
 * mode — the secret-less client whose id encodes our own origin — and it is
 * the only mode that may claim an `Origin` header on the token request. A
 * confidential client that also claimed a browser origin is a mode violation:
 * our own reference IdP answers `origin_cors_denied` to it, and a real
 * provider has no reason to be kinder.
 */
export type FederatedClientMode = {
  clientId: string;
  auth: client.ClientAuth;
  originProfile: boolean;
  scopes: string;
  /** Apple: the assertion comes back as a cross-site form POST (D3). */
  responseMode?: "form_post";
};

/**
 * The OIDC descriptor behind a static trust resolution.
 *
 * An `oauth2` descriptor is trusted, but it is not this leg's to run: it has
 * no discovery document and no id_token, which is the entire reason the
 * generic OAuth2 leg exists (`./oauth2.ts`, D2). Reaching here with one means
 * a pending cookie claimed `kind: "oidc"` for an OAuth2 provider, so it fails
 * closed rather than attempting discovery against an authorize URL.
 */
function oidcDescriptor(trust: TrustResolution): OidcProviderDescriptor {
  if (trust.source !== "static") {
    throw new Error("oidcDescriptor called for a non-static resolution");
  }
  if (trust.provider.kind !== "oidc") {
    throw new FederatedAuthError(
      "discovery_failed",
      "That sign-in provider does not speak OpenID Connect",
    );
  }
  return trust.provider;
}

async function staticClientMode(
  config: ControlPlaneConfig,
  provider: OidcProviderDescriptor,
): Promise<FederatedClientMode> {
  const scopes = provider.scopes || DEFAULT_OIDC_SCOPES;
  const responseMode =
    provider.responseMode !== undefined
      ? { responseMode: provider.responseMode }
      : undefined;

  if (provider.clientAuth === "apple_es256") {
    // Validated at config load: `apple_es256` implies clientId + key material.
    const apple = provider.apple;
    const clientId = provider.clientId;
    if (!apple || !clientId) {
      throw new FederatedAuthError(
        "discovery_failed",
        "That sign-in provider is misconfigured",
      );
    }
    return {
      clientId,
      auth: client.ClientSecretPost(
        await mintAppleClientSecret(apple, clientId),
      ),
      originProfile: false,
      scopes,
      ...responseMode,
    };
  }

  if (provider.clientAuth === "client_secret_post") {
    if (!provider.clientId || !provider.clientSecret) {
      throw new FederatedAuthError(
        "discovery_failed",
        "That sign-in provider is misconfigured",
      );
    }
    return {
      clientId: provider.clientId,
      auth: client.ClientSecretPost(provider.clientSecret),
      originProfile: false,
      scopes,
      ...responseMode,
    };
  }

  // `clientAuth: "none"` with a configured client id is a registered public
  // client (an IdP that issues no secret); without one it is the derived
  // origin-profile client, and only that one pins the Origin header.
  const configured = provider.clientId;
  return {
    clientId: configured ?? originClientId(config),
    auth: client.None(),
    originProfile: configured === undefined,
    scopes,
    ...responseMode,
  };
}

/**
 * How we authenticate to a given upstream, derived per trust resolution and
 * never from a global. The modes are exclusive and chosen by configuration,
 * never negotiated at runtime.
 */
export async function clientModeFor(
  config: ControlPlaneConfig,
  trust: TrustResolution,
): Promise<FederatedClientMode> {
  if (trust.source === "static") {
    return staticClientMode(config, oidcDescriptor(trust));
  }
  if (trust.source === "byo") {
    // The visitor's own registration: their client id, and their secret only
    // when they registered one (or RFC 7591 minted one for us). Never our
    // origin — the record names a client at *their* IdP.
    const record = trust.record;
    return {
      clientId: record.clientId,
      auth:
        record.clientAuth === "client_secret_post"
          ? client.ClientSecretPost(record.clientSecret ?? "")
          : client.None(),
      originProfile: false,
      scopes: DEFAULT_OIDC_SCOPES,
    };
  }
  // An organization's configured issuer: the tenant registered our origin
  // profile with their IdP, or brokers through one that accepts it.
  return {
    clientId: originClientId(config),
    auth: client.None(),
    originProfile: true,
    scopes: DEFAULT_OIDC_SCOPES,
  };
}

export function federatedRedirectUri(
  config: ControlPlaneConfig,
  uid: string,
): string {
  const base = config.publicUrl.replace(/\/+$/, "");
  return `${base}/interaction/${encodeURIComponent(uid)}/federated/callback`;
}

/**
 * A broker validating an origin-profile client checks the `Origin` header
 * byte-equals the origin encoded in the client id (see
 * `apps/mock-upstream-idp/src/server.ts`, which answers `origin_cors_denied`
 * otherwise). A browser sets that header itself; a server-side exchange must
 * set it explicitly, and it must be our real public origin — the same value
 * already baked into the client id, so this asserts nothing new.
 */
function originPinnedFetch(origin: string): client.CustomFetch {
  return (url, options) => {
    // SAFETY: CustomFetchOptions is the fetch init shape openid-client already
    // built (method/headers/body/signal); only the Origin header is added.
    const init: RequestInit = overlapCast({
      ...options,
      headers: { ...options.headers, Origin: origin },
    });
    return fetch(url, init);
  };
}

/**
 * Discovery results, cached per issuer AND per client id (T1).
 *
 * One issuer can now be reached as more than one client — the same corporate
 * IdP might be a registry provider for the deployment and a BYO record for a
 * visitor — and an `openid-client` Configuration binds the client id and its
 * authentication method, not just the server metadata. Keying on the issuer
 * alone would hand the second caller the first caller's credentials.
 */
const discoveryCache = new Map<string, Promise<client.Configuration>>();

/** Exposed for tests; discovery results are cached per issuer per process. */
export function resetFederatedDiscoveryCache(): void {
  discoveryCache.clear();
}

function discoveryCacheKey(issuer: string, clientId: string): string {
  return `${issuer}|${clientId}`;
}

async function upstreamConfiguration(
  ctx: AppContext,
  issuer: string,
  mode: FederatedClientMode,
): Promise<client.Configuration> {
  const key = discoveryCacheKey(issuer, mode.clientId);
  const cached = discoveryCache.get(key);
  if (cached) return cached;

  const options: client.DiscoveryRequestOptions = {
    // The Origin header is what binds an origin-profile client; every other
    // mode is bound by its credential and must not claim a browser origin.
    ...(mode.originProfile
      ? { [client.customFetch]: originPinnedFetch(siteOrigin(ctx.config)) }
      : undefined),
    // Only a dev stack may point at an http:// broker; production config
    // refuses a non-HTTPS entry in the allowlist outright (assertSecureConfig).
    ...(ctx.config.allowDevDefaults
      ? { execute: [client.allowInsecureRequests] }
      : undefined),
  };

  const pending = client
    .discovery(new URL(issuer), mode.clientId, undefined, mode.auth, options)
    .catch((cause: unknown) => {
      // A failed discovery must not poison the cache for later attempts.
      discoveryCache.delete(key);
      throw new FederatedAuthError(
        "discovery_failed",
        `Could not reach the sign-in provider at ${issuer}`,
        { cause },
      );
    });
  discoveryCache.set(key, pending);
  return pending;
}

/**
 * Resolve who vouches for this issuer, or refuse (C2).
 *
 * `undefined` is `untrusted_issuer` — the issuer arrives in a form field or a
 * cookie, so this is the fence, and it runs before anything touches a network.
 */
async function resolveOrRefuse(
  ctx: AppContext,
  issuer: string,
): Promise<TrustResolution> {
  const trust = await resolveTrustedIssuer(ctx, issuer);
  if (!trust) {
    throw new FederatedAuthError(
      "untrusted_issuer",
      "That sign-in provider is not trusted by this server",
    );
  }
  return trust;
}

/** The v2 pending fields a trust resolution implies (C3). */
function pendingProvenance(
  trust: TrustResolution,
): Pick<PendingFederatedAuth, "kind" | "providerId" | "byoId" | "orgId"> {
  if (trust.source === "static") {
    return { kind: trust.provider.kind, providerId: trust.provider.id };
  }
  if (trust.source === "byo") {
    return { kind: "oidc", byoId: trust.record.id };
  }
  return { kind: "oidc", orgId: trust.organizationId };
}

/**
 * Start the leg: returns where to send the browser and the state to stash.
 * Throws `untrusted_issuer` for anything no authority vouches for — the issuer
 * arrives in a form field, so this is the fence.
 */
export async function beginFederatedAuth(
  ctx: AppContext,
  uid: string,
  issuer: string,
): Promise<FederatedAuthStart> {
  const trust = await resolveOrRefuse(ctx, issuer);
  const mode = await clientModeFor(ctx.config, trust);
  const config = await upstreamConfiguration(ctx, issuer, mode);

  const verifier = client.randomPKCECodeVerifier();
  const challenge = await client.calculatePKCECodeChallenge(verifier);
  const state = client.randomState();
  const nonce = client.randomNonce();

  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: federatedRedirectUri(ctx.config, uid),
    scope: mode.scopes,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
    // Apple answers the authorization request with a cross-site form POST
    // rather than a redirect; the POST route re-materializes it (D3).
    ...(mode.responseMode !== undefined
      ? { response_mode: mode.responseMode }
      : undefined),
  });

  return {
    authorizationUrl: url.href,
    pending: { issuer, state, nonce, verifier, ...pendingProvenance(trust) },
  };
}

/**
 * Finish the leg. `currentUrl` is the full callback URL as received. The
 * expected state and nonce come from the pending cookie, so a replayed or
 * cross-flow code is rejected by openid-client before we ever see claims.
 */
export async function completeFederatedAuth(
  ctx: AppContext,
  pending: PendingFederatedAuth,
  currentUrl: URL,
): Promise<FederatedIdentity> {
  const trust = await resolveOrRefuse(ctx, pending.issuer);
  const mode = await clientModeFor(ctx.config, trust);
  const config = await upstreamConfiguration(ctx, pending.issuer, mode);

  let rawIdToken: string;
  try {
    const tokens = await client.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: pending.verifier,
      expectedState: pending.state,
      expectedNonce: pending.nonce,
      idTokenExpected: true,
    });
    rawIdToken = tokens.id_token ?? "";
    // The identity plane takes no custody of upstream credentials (D13).
    disposeRefreshToken(ctx, config, mode, tokens.refresh_token);
  } catch (cause) {
    throw new FederatedAuthError(
      "exchange_failed",
      "The sign-in provider rejected this sign-in",
      { cause },
    );
  }
  // Belt and braces, and deliberately unreachable today: `idTokenExpected:
  // true` above makes openid-client reject a token-less response before we get
  // here, which the "response carries no id_token at all" chaos case proves by
  // still failing closed. Kept so that a future change to those grant checks
  // cannot silently turn a missing assertion into an anonymous admission.
  if (!rawIdToken) {
    throw new FederatedAuthError(
      "exchange_failed",
      "The sign-in provider returned no id_token",
    );
  }

  /*
   * Verify the id_token's SIGNATURE against the issuer's published JWKS.
   *
   * openid-client does not do this for the code grant, and it is right not to
   * have to: OIDC Core §3.1.3.7 lets a client lean on TLS to the token
   * endpoint instead. But `docs/architecture/federated-signin.md` §7.5 states
   * that the signature is checked against the discovered JWKS, and that
   * document is the contract. Leaning on TLS alone would also mean a dev or
   * self-hosted stack pointed at an `http://` broker has no integrity check on
   * the assertion at all.
   *
   * `verifyOrgIdToken` is the same verifier the agent-facing
   * POST /v1/principals/link-identities path already uses: it pins RS256/ES256,
   * discovers the JWKS, checks `iss`, and applies the pairwise-over-global
   * subject precedence. Reusing it keeps one definition of "verified upstream
   * identity" for both surfaces. openid-client has meanwhile checked `aud`,
   * `nonce` and `exp`, which this verifier does not; together they cover the
   * whole claim set.
   */
  let verified: VerifiedOrgIdToken;
  try {
    verified = await verifyOrgIdToken(rawIdToken, pending.issuer);
  } catch (cause) {
    throw new FederatedAuthError(
      "exchange_failed",
      "The sign-in provider's assertion did not verify",
      { cause },
    );
  }

  const email = verified.email?.trim().toLowerCase();
  return {
    kind: "oidc",
    issuer: pending.issuer,
    subject: verified.sub,
    ...(email ? { email } : undefined),
    ...(verified.name ? { name: verified.name } : undefined),
    ...(verified.emailVerified !== undefined
      ? { emailVerified: verified.emailVerified }
      : undefined),
  };
}

/** Seconds we will wait on a best-effort upstream revocation (D13). */
const REFRESH_REVOCATION_TIMEOUT_SECONDS = 3;

/**
 * Dispose of an upstream refresh token we never asked for (D13).
 *
 * The legs request no offline scope, but an upstream may issue one anyway.
 * Storing it would make the identity plane a custodian of somebody else's
 * long-lived credential, which ADR 0005's posture forbids outright — so it is
 * never persisted, and where the issuer advertises RFC 7009 revocation it is
 * also handed back. Best effort by design: a broker that refuses or hangs must
 * not fail a sign-in that has already succeeded, so this is fire-and-forget
 * behind a short timeout, and dropping the token remains the real guarantee.
 */
export function disposeRefreshToken(
  ctx: AppContext,
  config: client.Configuration,
  mode: FederatedClientMode,
  refreshToken: string | undefined,
): void {
  if (!refreshToken) return;
  const metadata = config.serverMetadata();
  if (!metadata.revocation_endpoint) return;

  // Nothing in here may throw into the caller. It runs on the success path of
  // a sign-in that has already completed; a courtesy call that failed loudly
  // would turn a working sign-in into a 400.
  try {
    // A dedicated Configuration so the short timeout applies here only: the
    // cached discovery Configuration is shared by every interactive exchange.
    const revocation = new client.Configuration(
      metadata,
      mode.clientId,
      undefined,
      mode.auth,
    );
    revocation.timeout = REFRESH_REVOCATION_TIMEOUT_SECONDS;
    if (mode.originProfile) {
      revocation[client.customFetch] = originPinnedFetch(
        siteOrigin(ctx.config),
      );
    }
    if (ctx.config.allowDevDefaults) {
      client.allowInsecureRequests(revocation);
    }

    void client
      .tokenRevocation(revocation, refreshToken, {
        token_type_hint: "refresh_token",
      })
      .catch((cause: unknown) => {
        ctx.log.warn(
          {
            issuer: metadata.issuer,
            error: cause instanceof Error ? cause.name : "unknown",
          },
          "upstream refresh-token revocation failed",
        );
      });
  } catch (cause) {
    ctx.log.warn(
      {
        issuer: metadata.issuer,
        error: cause instanceof Error ? cause.name : "unknown",
      },
      "upstream refresh-token revocation could not be attempted",
    );
  }
}

/**
 * Identity kinds a federated subject can be linked under (C5). Back-channel
 * logout names an issuer and a subject but not a kind, so every leg's rows are
 * considered — a SAML session must end when its IdP says the human left.
 */
const REVOCABLE_IDENTITY_KINDS = [
  "oidc",
  "oauth2",
  "saml",
  "ldap",
  "email",
] as const;

/**
 * Revoke every live provisional session belonging to the principals linked to
 * `(issuer, subject)`; returns how many sessions ended (C17).
 *
 * This is the effect half of OIDC Back-Channel Logout (S10 owns the endpoint
 * that verifies the `logout_token`). It deliberately takes an issuer and a
 * subject rather than a principal id: the caller is holding an upstream
 * assertion, and resolving it to principals here keeps the tuple lookup — the
 * one binding that matters — in one place.
 */
export async function revokeSessionsForIdentity(
  ctx: AppContext,
  issuer: string,
  subject: string,
): Promise<number> {
  const principalIds = new Set<string>();
  for (const kind of REVOCABLE_IDENTITY_KINDS) {
    const identity = await ctx.repos.externalIdentities.findByTuple({
      kind,
      issuer,
      subject,
    });
    if (identity) principalIds.add(identity.principalId);
  }
  if (principalIds.size === 0) return 0;

  const now = ctx.clock();
  let revoked = 0;
  for (const [sessionId, session] of ctx.stores.provisionalSessions) {
    if (!principalIds.has(session.principalId)) continue;
    if (session.revokedAt) continue;
    ctx.stores.provisionalSessions.set(sessionId, {
      ...session,
      revokedAt: now,
    });
    for (const [token, id] of ctx.stores.provisionalTokens) {
      if (id === sessionId) ctx.stores.provisionalTokens.delete(token);
    }
    revoked += 1;
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "principal.provisional_revoked",
      outcome: "succeeded",
      principalId: session.principalId,
      sessionId,
      correlationId: `upstream-logout-${sessionId}`,
      actorType: "system",
      metadata: {
        action: "principal.provisional_revoke",
        issuer,
        via: "upstream_logout",
      },
    });
  }
  return revoked;
}

/** Cookie carrying `PendingFederatedAuth`, scoped to this interaction only. */
export function pendingCookieName(uid: string): string {
  return `os.fed.${uid}`;
}

export function encodePending(pending: PendingFederatedAuth): string {
  return Buffer.from(JSON.stringify(pending), "utf8").toString("base64url");
}

export function decodePending(
  raw: string | undefined,
): PendingFederatedAuth | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const result = pendingFederatedAuthSchema.safeParse(parsed);
    if (!result.success) return undefined;
    // Rebuilt field by field rather than handed back whole: an absent v2 field
    // must stay absent, not become a present `undefined`. The difference is
    // visible — `{...pending, kind: undefined}` re-encodes as a cookie
    // claiming a `kind` of `null`, which then fails to parse on the way back.
    const data = result.data;
    return {
      issuer: data.issuer,
      state: data.state,
      nonce: data.nonce,
      verifier: data.verifier,
      ...(data.kind !== undefined ? { kind: data.kind } : undefined),
      ...(data.providerId !== undefined
        ? { providerId: data.providerId }
        : undefined),
      ...(data.byoId !== undefined ? { byoId: data.byoId } : undefined),
      ...(data.orgId !== undefined ? { orgId: data.orgId } : undefined),
    };
  } catch {
    return undefined;
  }
}
