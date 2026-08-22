import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
} from "jose";
import { AuthorizationError } from "./errors.js";
import { hasRequiredScopes, isJwtString, trimSlash } from "./jwt-utils.js";

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
  jwks?: JSONWebKeySet;
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
  const embedded = ipv4FromMappedIpv6(host);
  if (embedded) return isLoopbackV4(embedded);
  return isLoopbackV4(host);
}

function isLoopbackV4(host: string): boolean {
  return /^127(?:\.\d{1,3}){3}$/u.test(host);
}

function ipv4FromMappedIpv6(host: string): string | null {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(host);
  if (dotted) return dotted[1] ?? null;
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(host);
  if (mappedHex?.[1] && mappedHex[2]) {
    return hextetsToIpv4(mappedHex[1], mappedHex[2]);
  }
  const compat = /^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(host);
  if (compat?.[1] && compat[2] && compat[1] !== "ffff") {
    return hextetsToIpv4(compat[1], compat[2]);
  }
  return null;
}

function hextetsToIpv4(hiHex: string, loHex: string): string {
  const hi = Number.parseInt(hiHex, 16);
  const lo = Number.parseInt(loHex, 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

/**
 * Hosts that only mean something inside this network. A remote issuer naming one
 * of these is not describing where its keys are; it is asking this process to
 * make a request on its behalf to somewhere it cannot reach itself.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (isLoopbackHost(host)) return true;
  if (host === "0.0.0.0" || host === "::" || host === "localhost") return true;
  const embedded = ipv4FromMappedIpv6(host);
  if (embedded) return isPrivateV4(embedded);
  if (isPrivateV4(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/u.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/u.test(host)) return true;
  return host.endsWith(".internal") || host.endsWith(".local");
}

function isPrivateV4(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
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

/**
 * A key set URI that an issuer told us about, rather than one an operator wrote.
 *
 * `assertSecureUrl` permits cleartext on loopback, which is the right affordance
 * for a value in this deployment's own configuration and the wrong one for a value
 * a remote party supplies: it lets any issuer aim this process's key fetch at
 * 127.0.0.1, or at link-local metadata, and read the result's effect through
 * whether verification succeeded. So a discovered URI may only name a private host
 * when the issuer is itself one — the local development case, where both sides of
 * the pair are on this machine anyway.
 */
export function assertDiscoveredJwksUri(raw: string, issuer: URL): URL {
  const url = assertSecureUrl(raw, "jwks_uri");
  if (isPrivateHost(issuer.hostname)) return url;
  if (isPrivateHost(url.hostname)) {
    throw new Error(
      "jwks_uri names a private or loopback host, but the issuer is remote",
    );
  }
  return url;
}

export interface OpenSesameVerifier {
  verifyAccessToken(token: string): Promise<VerifiedIdentity>;
}

export interface JwksKeySourceConfig {
  issuer: string;
  jwksUri?: string;
  jwks?: JSONWebKeySet;
  fetchImpl?: typeof fetch;
}

/**
 * Shared JWKS resolution for access-token and ID-token verification.
 * Operator-configured URIs are fenced at construction; discovered URIs use
 * `assertDiscoveredJwksUri` so a remote issuer cannot aim the key fetch at
 * private space.
 */
export function createJwksKeySource(
  config: JwksKeySourceConfig,
): () => Promise<JWTVerifyGetKey> {
  const issuer = trimSlash(config.issuer);
  assertSecureUrl(issuer, "issuer");
  const configuredJwksUri =
    config.jwksUri === undefined
      ? undefined
      : assertSecureUrl(config.jwksUri, "jwksUri");

  async function discoverJwksUri(): Promise<URL> {
    const issuerUrl = new URL(issuer);
    const fetchImpl = config.fetchImpl ?? globalThis.fetch;
    const fallback = (): URL => assertSecureUrl(`${issuer}/jwks`, "jwksUri");
    if (!fetchImpl) return fallback();
    let meta: BoundaryValue;
    try {
      const res = await fetchImpl(
        `${issuer}/.well-known/openid-configuration`,
        { headers: { accept: "application/json" } },
      );
      if (!res.ok) return fallback();
      meta = await res.json();
    } catch {
      return fallback();
    }
    if (!isJsonObject(meta)) {
      throw new Error("Discovery document is not a JSON object");
    }
    if (!isString(meta.issuer)) {
      throw new Error("Discovery document does not name the configured issuer");
    }
    if (trimSlash(meta.issuer) !== issuer) {
      throw new Error("Discovery document does not name the configured issuer");
    }
    if (!isString(meta.jwks_uri)) {
      return fallback();
    }
    return assertDiscoveredJwksUri(meta.jwks_uri, issuerUrl);
  }

  let remoteKeys: JWTVerifyGetKey | undefined;
  let pending: Promise<JWTVerifyGetKey> | undefined;
  return async function keySource(): Promise<JWTVerifyGetKey> {
    if (config.jwks) {
      return createLocalJWKSet(config.jwks);
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
  };
}

function asAudienceList(aud: string | string[]): string[] {
  return Array.isArray(aud) ? aud : [aud];
}

export function createOpenSesameVerifier(
  config: OpenSesameVerifierConfig,
): OpenSesameVerifier {
  const issuer = trimSlash(config.issuer);
  const audiences = asAudienceList(config.audience);
  const defaultAudience = audiences[0];
  if (!defaultAudience) throw new Error("audience must not be empty");
  const algorithms = config.algorithms ?? [...DEFAULT_ALLOWED_ALGORITHMS];
  const keySource = createJwksKeySource({
    issuer,
    ...(config.jwksUri !== undefined ? { jwksUri: config.jwksUri } : undefined),
    ...(config.jwks !== undefined ? { jwks: config.jwks } : undefined),
    ...(config.fetchImpl !== undefined
      ? { fetchImpl: config.fetchImpl }
      : undefined),
  });

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
          ? { ...common, audience: defaultAudience }
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

      const tokenUse = isJwtString(payload.token_use)
        ? payload.token_use
        : isJwtString(payload.typ)
          ? payload.typ
          : undefined;
      if (tokenUse === "id" || tokenUse === "refresh") {
        throw new Error(`Unexpected token type: ${tokenUse}`);
      }

      const scopeClaim = payload.scp;
      const scope = isJwtString(payload.scope)
        ? payload.scope
        : isJwtString(scopeClaim)
          ? scopeClaim
          : Array.isArray(scopeClaim) && scopeClaim.every(isJwtString)
            ? scopeClaim.join(" ")
            : undefined;

      if (!hasRequiredScopes(scope, config.requiredScopes ?? [])) {
        throw new AuthorizationError(
          "insufficient_scope",
          "Token missing required scopes",
        );
      }

      const namespacedAssurance = payload["os:assurance"];
      const assurance = isJwtString(payload.assurance)
        ? payload.assurance
        : isJwtString(namespacedAssurance)
          ? namespacedAssurance
          : undefined;

      const identity: VerifiedIdentity = {
        sub: payload.sub,
        iss: payload.iss,
        aud: payload.aud ?? defaultAudience,
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
