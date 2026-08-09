import {
  type JWTPayload,
  type JWTVerifyGetKey,
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
} from "jose";

export interface VerifiedIdentity {
  sub: string;
  iss: string;
  aud: string | string[];
  scope?: string;
  assurance?: string;
  tokenUse?: string;
  payload: JWTPayload;
  accessToken: string;
}

export interface OpenSesameVerifierConfig {
  issuer: string;
  audience: string | string[];
  /**
   * Override the JWKS URI. When absent the issuer's discovery document is read
   * and its `jwks_uri` used; `{issuer}/jwks` is only a last resort for an issuer
   * that publishes no metadata.
   */
  jwksUri?: string;
  /** Injected for tests, and for a deployment that cannot reach discovery at boot. */
  fetchImpl?: typeof fetch;
  /** Inject local JWKS for tests. */
  jwks?: { keys: unknown[] };
  clockToleranceSeconds?: number;
  requiredScopes?: string[];
  /**
   * Signature algorithms this resource server accepts. Defaults to the
   * asymmetric set below — a token is only as trustworthy as the algorithm it
   * was signed with, and that choice belongs to the verifier, not the token.
   */
  algorithms?: string[];
  /**
   * Require the RFC 9068 `typ` header (`at+jwt`) when the issuer stamps one.
   * Off by default: not every issuer emits it.
   */
  requireAccessTokenTypeHeader?: boolean;
}

/**
 * Asymmetric algorithms only. A JWKS the verifier fetched over the network is a
 * set of public keys; accepting a MAC algorithm would let whatever is in that
 * set double as a signing secret.
 */
export const DEFAULT_ALLOWED_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
  "Ed25519",
] as const;

/** Claims a resource server has no business inferring. `exp` above all: a token without one never stops. */
const REQUIRED_CLAIMS = ["iss", "sub", "aud", "exp"];

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  return /^127(?:\.\d{1,3}){3}$/u.test(host);
}

/**
 * Keys and issuer names must arrive over a channel someone cannot rewrite.
 * A JWKS fetched over cleartext is a JWKS an attacker on the path chooses, and
 * then every signature check below is theatre.
 */
export function assertSecureUrl(raw: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${what} must be an absolute URL`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url;
  throw new Error(
    `${what} must use https (http is allowed only on loopback for local development)`,
  );
}

export interface OpenSesameVerifier {
  verifyAccessToken(token: string): Promise<VerifiedIdentity>;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}

function asAudienceList(aud: string | string[]): string[] {
  return Array.isArray(aud) ? aud : [aud];
}

function hasRequiredScopes(
  scope: string | undefined,
  required: string[],
): boolean {
  if (required.length === 0) return true;
  const have = new Set((scope ?? "").split(/\s+/u).filter(Boolean));
  return required.every((s) => have.has(s));
}

export function createOpenSesameVerifier(
  config: OpenSesameVerifierConfig,
): OpenSesameVerifier {
  const issuer = trimSlash(config.issuer);
  const audiences = asAudienceList(config.audience);
  assertSecureUrl(issuer, "issuer");
  const algorithms = config.algorithms ?? [...DEFAULT_ALLOWED_ALGORITHMS];
  // An explicit JWKS URI is checked while the verifier is being built, not on the
  // first request: a misconfigured resource server should fail to start.
  const configuredJwksUri =
    config.jwksUri === undefined
      ? undefined
      : assertSecureUrl(config.jwksUri, "jwksUri");

  /**
   * Where this issuer says its keys are.
   *
   * Guessing `{issuer}/jwks` is right for this deployment and wrong in general:
   * an issuer names its own key set in its discovery document. The document is
   * only believed if it names the issuer we were configured with, and the URI it
   * gives must still arrive over a channel nobody can rewrite.
   */
  async function discoverJwksUri(): Promise<URL> {
    const fetchImpl = config.fetchImpl ?? globalThis.fetch;
    const fallback = (): URL => assertSecureUrl(`${issuer}/jwks`, "jwksUri");
    if (!fetchImpl) return fallback();
    let meta: { issuer?: unknown; jwks_uri?: unknown };
    try {
      const res = await fetchImpl(
        `${issuer}/.well-known/openid-configuration`,
        { headers: { accept: "application/json" } },
      );
      if (!res.ok) return fallback();
      meta = (await res.json()) as { issuer?: unknown; jwks_uri?: unknown };
    } catch {
      return fallback();
    }
    if (typeof meta.issuer !== "string" || trimSlash(meta.issuer) !== issuer) {
      throw new Error("Discovery document does not name the configured issuer");
    }
    if (typeof meta.jwks_uri !== "string") return fallback();
    return assertSecureUrl(meta.jwks_uri, "jwks_uri");
  }

  let remoteKeys: JWTVerifyGetKey | undefined;
  let pending: Promise<JWTVerifyGetKey> | undefined;
  async function keySource(): Promise<JWTVerifyGetKey> {
    if (config.jwks) {
      return createLocalJWKSet(
        config.jwks as Parameters<typeof createLocalJWKSet>[0],
      );
    }
    if (configuredJwksUri) {
      remoteKeys ??= createRemoteJWKSet(configuredJwksUri);
      return remoteKeys;
    }
    if (remoteKeys) return remoteKeys;
    pending ??= discoverJwksUri()
      .then((uri) => {
        remoteKeys = createRemoteJWKSet(uri);
        return remoteKeys;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }

  return {
    async verifyAccessToken(token: string): Promise<VerifiedIdentity> {
      const common = {
        issuer,
        clockTolerance: config.clockToleranceSeconds ?? 5,
        algorithms,
        requiredClaims: REQUIRED_CLAIMS,
      };
      const verifyOptions =
        audiences.length === 1
          ? { ...common, audience: audiences[0]! }
          : { ...common, audience: audiences };

      const { payload, protectedHeader } = await jwtVerify(
        token,
        await keySource(),
        verifyOptions,
      );

      if (
        config.requireAccessTokenTypeHeader === true &&
        protectedHeader.typ?.toLowerCase() !== "at+jwt"
      ) {
        throw new Error("Token is not an RFC 9068 access token");
      }

      if (payload.sub === undefined || payload.sub === "") {
        throw new Error("Token missing sub");
      }
      if (payload.iss === undefined) {
        throw new Error("Token missing iss");
      }

      const tokenUse =
        typeof payload.token_use === "string"
          ? payload.token_use
          : typeof payload.typ === "string"
            ? payload.typ
            : undefined;
      if (tokenUse === "id" || tokenUse === "refresh") {
        throw new Error(`Unexpected token type: ${tokenUse}`);
      }

      const scope =
        typeof payload.scope === "string"
          ? payload.scope
          : typeof payload.scp === "string"
            ? payload.scp
            : Array.isArray(payload.scp)
              ? payload.scp.map(String).join(" ")
              : undefined;

      if (!hasRequiredScopes(scope, config.requiredScopes ?? [])) {
        throw new Error("Token missing required scopes");
      }

      const assurance =
        typeof payload.assurance === "string"
          ? payload.assurance
          : typeof payload["os:assurance"] === "string"
            ? (payload["os:assurance"] as string)
            : undefined;

      const identity: VerifiedIdentity = {
        sub: payload.sub,
        iss: payload.iss,
        aud: (payload.aud as string | string[]) ?? audiences[0]!,
        payload,
        accessToken: token,
      };
      if (scope !== undefined) identity.scope = scope;
      if (assurance !== undefined) identity.assurance = assurance;
      if (tokenUse !== undefined) identity.tokenUse = tokenUse;
      return identity;
    },
  };
}

export type { JWTPayload };
