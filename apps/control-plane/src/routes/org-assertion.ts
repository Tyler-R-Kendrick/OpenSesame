import { type JsonObject, isString, overlapCast } from "@opensesame/os-domain";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";

const ALLOWED_ALGS = ["RS256", "ES256"] as const;
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

async function discoverJwksUriDefault(issuer: string): Promise<string> {
  const url = `${issuerOrigin(issuer)}/.well-known/openid-configuration`;
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(DISCOVERY_MS),
    });
  } catch {
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

async function verifyOrgIdTokenDefault(
  idToken: string,
  issuer: string,
): Promise<{ sub: string }> {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(idToken);
  } catch {
    throw new OrgAssertionError("invalid_token", "Not a JWT.");
  }
  if (
    !isString(header.alg) ||
    !(ALLOWED_ALGS as readonly string[]).includes(header.alg)
  ) {
    throw new OrgAssertionError(
      "invalid_token",
      "Token algorithm is not allowed.",
    );
  }

  const jwksUri = await orgAssertionSeams.discoverJwksUri(issuer);
  let payload: JsonObject;
  try {
    const verified = await jwtVerify(
      idToken,
      createRemoteJWKSet(new URL(jwksUri)),
      {
        issuer: issuerOrigin(issuer),
        algorithms: [...ALLOWED_ALGS],
        clockTolerance: 5,
      },
    );
    payload = overlapCast(verified.payload);
  } catch (error) {
    if (error instanceof OrgAssertionError) throw error;
    throw new OrgAssertionError("invalid_token", "Token was not accepted.");
  }

  const pairwise =
    typeof payload.pairwise_sub === "string" ? payload.pairwise_sub : "";
  const sub = pairwise || (typeof payload.sub === "string" ? payload.sub : "");
  if (!sub) {
    throw new OrgAssertionError("invalid_token", "Token carries no subject.");
  }
  return { sub };
}

export const orgAssertionSeams = {
  discoverJwksUri: discoverJwksUriDefault,
  verifyOrgIdToken: verifyOrgIdTokenDefault,
};

export async function verifyOrgIdToken(
  idToken: string,
  issuer: string,
): Promise<{ sub: string }> {
  return orgAssertionSeams.verifyOrgIdToken(idToken, issuer);
}
