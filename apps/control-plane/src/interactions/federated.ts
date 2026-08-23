import { overlapCast } from "@opensesame/os-domain";
import * as client from "openid-client";
import type { ControlPlaneConfig } from "../config.js";
import type { AppContext } from "../context.js";
import {
  type VerifiedOrgIdToken,
  verifyOrgIdToken,
} from "../routes/org-assertion.js";

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
 * Protocol work is delegated to panva `openid-client` rather than hand-rolled
 * (ADR 0008). Better Auth is deliberately NOT used here: it is unmounted dead
 * code in this repo, and its social-provider mapping silently drops providers
 * with no client secret — which is every broker in the origin-profile contract.
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
 */
export type PendingFederatedAuth = {
  issuer: string;
  state: string;
  nonce: string;
  verifier: string;
};

/** Verified upstream claims. `subject` is already pairwise-resolved. */
export type FederatedIdentity = {
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

/** The upstreams the hosted login page may offer, in allowlist order. */
export function federatedUpstreams(
  config: ControlPlaneConfig,
): FederatedUpstream[] {
  return config.trustedUpstreamIssuers.map(describeUpstream);
}

/**
 * Resolve a provider hint (`kc_idp_hint` / `login_hint_provider`) to an
 * allowlisted issuer. Matches id, issuer, host, or label, case-insensitively.
 * An unknown hint resolves to undefined and is ignored — never echoed.
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
 * Confidential credentials configured *for this exact issuer*, or undefined.
 *
 * The issuer match is exact and is the whole point: a secret configured for
 * one broker must never travel to another, however the flow reached this
 * function. `assertSecureConfig` additionally refuses to boot when the
 * credentialed issuer is not in the trusted allowlist.
 */
function credentialsForIssuer(
  config: ControlPlaneConfig,
  issuer: string,
): { clientId: string; clientSecret: string } | undefined {
  const configured = config.upstreamClientCredentials;
  if (!configured || configured.issuer !== issuer) return undefined;
  return {
    clientId: configured.clientId,
    clientSecret: configured.clientSecret,
  };
}

/**
 * How we authenticate to a given broker. The two modes are exclusive per
 * issuer and chosen by configuration, never negotiated at runtime: a broker
 * with configured credentials gets a confidential client, everything else
 * gets the derived origin-profile public client.
 */
function clientModeFor(
  config: ControlPlaneConfig,
  issuer: string,
): { clientId: string; auth: client.ClientAuth; confidential: boolean } {
  const credentials = credentialsForIssuer(config, issuer);
  if (credentials) {
    return {
      clientId: credentials.clientId,
      auth: client.ClientSecretPost(credentials.clientSecret),
      confidential: true,
    };
  }
  return {
    clientId: originClientId(config),
    auth: client.None(),
    confidential: false,
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

const discoveryCache = new Map<string, Promise<client.Configuration>>();

/** Exposed for tests; discovery results are cached per issuer per process. */
export function resetFederatedDiscoveryCache(): void {
  discoveryCache.clear();
}

async function upstreamConfiguration(
  ctx: AppContext,
  issuer: string,
): Promise<client.Configuration> {
  const cached = discoveryCache.get(issuer);
  if (cached) return cached;

  const mode = clientModeFor(ctx.config, issuer);
  const options: client.DiscoveryRequestOptions = {
    // The Origin header is what binds an origin-profile client; a confidential
    // client is bound by its secret and must not claim a browser origin.
    ...(mode.confidential
      ? undefined
      : { [client.customFetch]: originPinnedFetch(siteOrigin(ctx.config)) }),
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
      discoveryCache.delete(issuer);
      throw new FederatedAuthError(
        "discovery_failed",
        `Could not reach the sign-in provider at ${issuer}`,
        { cause },
      );
    });
  discoveryCache.set(issuer, pending);
  return pending;
}

/**
 * Start the leg: returns where to send the browser and the state to stash.
 * Throws `untrusted_issuer` for anything outside the configured allowlist —
 * the issuer arrives in a form field, so this is the fence.
 */
export async function beginFederatedAuth(
  ctx: AppContext,
  uid: string,
  issuer: string,
): Promise<{ authorizationUrl: string; pending: PendingFederatedAuth }> {
  if (!isTrustedUpstream(ctx.config, issuer)) {
    throw new FederatedAuthError(
      "untrusted_issuer",
      "That sign-in provider is not trusted by this server",
    );
  }
  const config = await upstreamConfiguration(ctx, issuer);

  const verifier = client.randomPKCECodeVerifier();
  const challenge = await client.calculatePKCECodeChallenge(verifier);
  const state = client.randomState();
  const nonce = client.randomNonce();

  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: federatedRedirectUri(ctx.config, uid),
    scope: "openid email profile",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });

  return {
    authorizationUrl: url.href,
    pending: { issuer, state, nonce, verifier },
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
  if (!isTrustedUpstream(ctx.config, pending.issuer)) {
    throw new FederatedAuthError(
      "untrusted_issuer",
      "That sign-in provider is not trusted by this server",
    );
  }
  const config = await upstreamConfiguration(ctx, pending.issuer);

  let rawIdToken: string;
  try {
    const tokens = await client.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: pending.verifier,
      expectedState: pending.state,
      expectedNonce: pending.nonce,
      idTokenExpected: true,
    });
    rawIdToken = tokens.id_token ?? "";
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
    issuer: pending.issuer,
    subject: verified.sub,
    ...(email ? { email } : undefined),
    ...(verified.name ? { name: verified.name } : undefined),
    ...(typeof verified.emailVerified === "boolean"
      ? { emailVerified: verified.emailVerified }
      : undefined),
  };
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
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object") return undefined;
    const p = parsed as Record<string, unknown>;
    if (
      typeof p.issuer !== "string" ||
      typeof p.state !== "string" ||
      typeof p.nonce !== "string" ||
      typeof p.verifier !== "string"
    ) {
      return undefined;
    }
    return {
      issuer: p.issuer,
      state: p.state,
      nonce: p.nonce,
      verifier: p.verifier,
    };
  } catch {
    return undefined;
  }
}
