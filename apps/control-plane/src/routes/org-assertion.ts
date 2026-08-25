import {
  UnsafeMetadataUrlError,
  assertSafeMetadataUrl,
} from "@opensesame/oauth-provider";
import {
  type JsonObject,
  isBoolean,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import {
  createRemoteJWKSet,
  customFetch,
  decodeProtectedHeader,
  jwtVerify,
} from "jose";

const ALLOWED_ALGS = ["RS256", "ES256"] as const;
const ALLOWED_ALG_SET = new Set<string>(ALLOWED_ALGS);
const DISCOVERY_MS = 5_000;

export class OrgAssertionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OrgAssertionError";
    this.code = code;
  }
}

function issuerOrigin(issuer: string): string {
  return issuer.replace(/\/+$/, "");
}

/**
 * The network fence in front of every URL this module dereferences.
 *
 * Both legs — the discovery document and the JWKS it names — are server-side
 * fetches of an operator-or-tenant-supplied URL, which is the classic SSRF
 * shape. The guard is the same one the OAuth provider uses for remote client
 * metadata (`assertSafeMetadataUrl`, ADR 0050): it refuses private, loopback,
 * link-local and cloud-metadata targets, including their decimal and
 * IPv6-mapped spellings.
 *
 * `blockPrivateHosts` is a caller decision because loopback is exactly where
 * the reference IdP and the local dev stack live: a deployment running with
 * dev defaults must still be able to federate to `127.0.0.1:9090`. Callers
 * that accept an issuer from outside pass `true` (see the tenant join route);
 * callers whose issuer already passed the trusted-issuer fence keep today's
 * behaviour by omitting it.
 */
function assertSafeIssuerUrl(rawUrl: string, blockPrivateHosts: boolean): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OrgAssertionError("invalid_issuer", "Issuer is not a URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new OrgAssertionError("invalid_issuer", "Issuer is not http(s).");
  }
  if (url.username || url.password) {
    throw new OrgAssertionError(
      "invalid_issuer",
      "Issuer URL must not carry credentials.",
    );
  }
  if (!blockPrivateHosts) return url;
  try {
    return assertSafeMetadataUrl(rawUrl);
  } catch (error) {
    if (error instanceof UnsafeMetadataUrlError) {
      throw new OrgAssertionError(
        "unsafe_issuer",
        "Issuer host is not reachable from this deployment.",
      );
    }
    throw error;
  }
}

type GuardedFetchInit = { headers?: HeadersInit; signal?: AbortSignal };

/**
 * Fetch a guarded URL. Redirects are refused rather than followed: a 302 to
 * `169.254.169.254` would otherwise walk straight past the host guard, which
 * only ever sees the first URL.
 */
async function safeIssuerFetch(
  rawUrl: string,
  blockPrivateHosts: boolean,
  init?: GuardedFetchInit,
): Promise<Response> {
  const url = assertSafeIssuerUrl(rawUrl, blockPrivateHosts);
  return fetch(url, {
    method: "GET",
    redirect: "error",
    signal: init?.signal ?? AbortSignal.timeout(DISCOVERY_MS),
    ...(init?.headers ? { headers: init.headers } : undefined),
  });
}

async function discoverJwksUriDefault(
  issuer: string,
  blockPrivateHosts = false,
): Promise<string> {
  const url = `${issuerOrigin(issuer)}/.well-known/openid-configuration`;
  let response: Response;
  try {
    response = await safeIssuerFetch(url, blockPrivateHosts);
  } catch (error) {
    if (error instanceof OrgAssertionError) throw error;
    throw new OrgAssertionError(
      "upstream_unavailable",
      `Could not reach ${issuer}.`,
    );
  }
  if (!response.ok) {
    throw new OrgAssertionError(
      "upstream_unavailable",
      `${issuer} returned ${response.status} for its discovery document.`,
    );
  }
  const doc = overlapCast(await response.json());
  if (!isString(doc.jwks_uri) || !doc.jwks_uri) {
    throw new OrgAssertionError(
      "upstream_unavailable",
      `${issuer} published no jwks_uri.`,
    );
  }
  if (
    isString(doc.issuer) &&
    issuerOrigin(doc.issuer) !== issuerOrigin(issuer)
  ) {
    throw new OrgAssertionError(
      "issuer_mismatch",
      `${issuer} claims to be ${doc.issuer}.`,
    );
  }
  return doc.jwks_uri;
}

/**
 * Subject plus the profile claims we are willing to carry forward.
 *
 * `email`/`emailVerified`/`name` are read straight off a payload that already
 * passed `jwtVerify`; they add no verification of their own and are never a
 * join key (see services/identity-link.ts). Keys are present only when the
 * token actually carried the claim.
 */
export type VerifiedOrgIdToken = {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
};

/**
 * The checks a caller may add on top of signature + issuer (ADR 0055).
 *
 * Omitting the object reproduces the pre-hardening behaviour exactly, because
 * the server-side relying-party leg calls it that way: there, `aud` is bound
 * by the code exchange and `nonce` by the pending cookie, so a second audience
 * rule would refuse tokens the leg itself minted the request for.
 */
export type VerifyOrgIdTokenOptions = {
  /**
   * Accepted `aud` values — the token must have been minted for one of OUR
   * surfaces. Empty or absent means the claim is not checked.
   */
  expectedAudiences?: string[];
  /** Maximum age from `iat`, in seconds. Absent means unbounded. */
  maxTokenAgeSec?: number;
  /** See {@link assertSafeIssuerUrl}. Default `false`. */
  blockPrivateIssuerHosts?: boolean;
};

async function verifyOrgIdTokenDefault(
  idToken: string,
  issuer: string,
  options: VerifyOrgIdTokenOptions = {},
): Promise<VerifiedOrgIdToken> {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(idToken);
  } catch {
    throw new OrgAssertionError("invalid_token", "Not a JWT.");
  }
  if (!isString(header.alg) || !ALLOWED_ALG_SET.has(header.alg)) {
    throw new OrgAssertionError(
      "invalid_token",
      "Token algorithm is not allowed.",
    );
  }

  const blockPrivateHosts = options.blockPrivateIssuerHosts ?? false;
  const jwksUri = await orgAssertionSeams.discoverJwksUri(
    issuer,
    blockPrivateHosts,
  );
  const jwksUrl = assertSafeIssuerUrl(jwksUri, blockPrivateHosts);
  const audiences = options.expectedAudiences?.filter(Boolean) ?? [];
  let payload: JsonObject;
  try {
    const verified = await jwtVerify(
      idToken,
      createRemoteJWKSet(jwksUrl, {
        // The key set is fetched through the same guard as discovery, and a
        // redirect off it is refused rather than followed.
        [customFetch]: (url, init) => {
          const guarded: GuardedFetchInit = {
            headers: init.headers,
            signal: init.signal,
          };
          return safeIssuerFetch(url, blockPrivateHosts, guarded);
        },
      }),
      {
        issuer: issuerOrigin(issuer),
        algorithms: [...ALLOWED_ALGS],
        clockTolerance: 5,
        ...(audiences.length > 0 ? { audience: audiences } : undefined),
        ...(options.maxTokenAgeSec !== undefined
          ? { maxTokenAge: options.maxTokenAgeSec }
          : undefined),
      },
    );
    payload = overlapCast(verified.payload);
  } catch (error) {
    if (error instanceof OrgAssertionError) throw error;
    throw new OrgAssertionError("invalid_token", "Token was not accepted.");
  }

  const pairwise = isString(payload.pairwise_sub) ? payload.pairwise_sub : "";
  const sub = pairwise || (isString(payload.sub) ? payload.sub : "");
  if (!sub) {
    throw new OrgAssertionError("invalid_token", "Token carries no subject.");
  }
  const email = isString(payload.email) ? payload.email : undefined;
  const emailVerified = isBoolean(payload.email_verified)
    ? payload.email_verified
    : undefined;
  const name = isString(payload.name) ? payload.name : undefined;
  return {
    sub,
    ...(email !== undefined ? { email } : undefined),
    ...(emailVerified !== undefined ? { emailVerified } : undefined),
    ...(name !== undefined ? { name } : undefined),
  };
}

export const orgAssertionSeams = {
  discoverJwksUri: discoverJwksUriDefault,
  verifyOrgIdToken: verifyOrgIdTokenDefault,
};

export async function verifyOrgIdToken(
  idToken: string,
  issuer: string,
  options?: VerifyOrgIdTokenOptions,
): Promise<VerifiedOrgIdToken> {
  return orgAssertionSeams.verifyOrgIdToken(idToken, issuer, options);
}

/**
 * The `aud` values a token minted for one of our own surfaces carries (T17).
 *
 * Pages runs the browser leg with `client_id = origin:<its own origin>`, so
 * the audience is the *client's* origin, not ours: hard-coding
 * `origin:<publicUrl>` refuses every join from the dev Pages server on :5180.
 * The accept-set is therefore the configured CORS origins plus our own public
 * URL, all in origin-client spelling (ADR 0050).
 */
export function originAudiences(config: {
  corsOrigins: string[];
  publicUrl: string;
}): string[] {
  const origins = new Set<string>();
  for (const candidate of [...config.corsOrigins, config.publicUrl]) {
    try {
      origins.add(`origin:${new URL(candidate).origin}`);
    } catch {
      // A malformed CORS entry contributes no audience rather than failing the
      // whole join: the remaining origins are still a closed accept-set.
    }
  }
  return [...origins];
}
