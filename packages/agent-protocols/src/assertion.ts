import { SignJWT, importJWK, jwtVerify } from "jose";
import type { JWK, JWTPayload } from "jose";

type SignKey = Parameters<InstanceType<typeof SignJWT>["sign"]>[0];
type VerifyKey = CryptoKey | Uint8Array;
import { PROVIDER_ID_JAG_TYP, SERVICE_ASSERTION_TYP } from "./constants.js";
import { agentAuthError } from "./errors.js";

export interface ServiceAssertionClaims {
  iss: string;
  aud: string;
  sub: string;
  jti: string;
  iat: number;
  exp: number;
  resource?: string;
  scope?: string;
  os_reg: string;
  os_claimed: boolean;
  os_av: number;
  act?: { sub: string };
}

export interface ServiceAssertionKey {
  privateKey: SignKey;
  publicJwk: JWK;
  kid: string;
  alg: "ES256" | "RS256";
}

export interface IssueServiceAssertionInput {
  issuer: string;
  audience: string;
  registrationId: string;
  claimed: boolean;
  assertionVersion: number;
  scopes: readonly string[];
  expiresAt: Date;
  now?: Date;
  resource?: string;
  actSub?: string;
  jti?: string;
}

function randomJti(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function decodeHeader(jwt: string): {
  typ?: string;
  alg?: string;
  kid?: string;
} {
  const headerB64 = jwt.split(".")[0];
  if (!headerB64)
    throw agentAuthError("invalid_grant", 400, "assertion is not a JWT");
  try {
    return JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as {
      typ?: string;
      alg?: string;
      kid?: string;
    };
  } catch {
    throw agentAuthError("invalid_grant", 400, "assertion is not a JWT");
  }
}

export async function issueServiceAgentIdentityAssertion(
  key: ServiceAssertionKey,
  input: IssueServiceAssertionInput,
): Promise<{ jwt: string; jti: string; claims: ServiceAssertionClaims }> {
  const now = input.now ?? new Date();
  const jti = input.jti ?? randomJti();
  const claims: ServiceAssertionClaims = {
    iss: input.issuer,
    aud: input.audience,
    sub: input.registrationId,
    jti,
    iat: Math.floor(now.getTime() / 1000),
    exp: Math.floor(input.expiresAt.getTime() / 1000),
    os_reg: input.registrationId,
    os_claimed: input.claimed,
    os_av: input.assertionVersion,
    scope: input.scopes.join(" "),
  };
  if (input.resource !== undefined) claims.resource = input.resource;
  if (input.actSub !== undefined) claims.act = { sub: input.actSub };

  const jwt = await new SignJWT({ ...claims })
    .setProtectedHeader({
      alg: key.alg,
      kid: key.kid,
      typ: SERVICE_ASSERTION_TYP,
    })
    .sign(key.privateKey);

  return { jwt, jti, claims };
}

export async function verifyServiceAgentIdentityAssertion(
  jwt: string,
  expected: {
    issuer: string;
    audience: string;
    resource?: string;
    getKey: (header: {
      kid?: string;
      alg?: string;
    }) => Promise<VerifyKey>;
  },
): Promise<ServiceAssertionClaims> {
  const header = decodeHeader(jwt);
  if (header.typ === PROVIDER_ID_JAG_TYP) {
    throw agentAuthError(
      "invalid_grant",
      400,
      "provider ID-JAG is not a service identity assertion",
    );
  }
  if (header.typ !== SERVICE_ASSERTION_TYP) {
    throw agentAuthError("invalid_grant", 400, "unexpected assertion typ");
  }
  if (header.alg !== "ES256" && header.alg !== "RS256") {
    throw agentAuthError("invalid_grant", 400, "rejected assertion algorithm");
  }

  const key = await expected.getKey({
    ...(header.kid ? { kid: header.kid } : {}),
    ...(header.alg ? { alg: header.alg } : {}),
  });
  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(jwt, key, {
      issuer: expected.issuer,
      audience: expected.audience,
      algorithms: ["ES256", "RS256"],
      clockTolerance: 60,
    });
    payload = verified.payload;
  } catch (err) {
    if (err instanceof Error && err.name === "AgentAuthError") throw err;
    throw agentAuthError("invalid_grant", 400, "assertion verification failed");
  }

  if (typeof payload.sub !== "string" || !payload.sub.startsWith("areg_")) {
    throw agentAuthError(
      "invalid_grant",
      400,
      "assertion subject is not a registration",
    );
  }
  if (typeof payload.jti !== "string") {
    throw agentAuthError("invalid_grant", 400, "assertion missing jti");
  }
  if (payload.os_reg !== payload.sub) {
    throw agentAuthError(
      "invalid_grant",
      400,
      "assertion registration mismatch",
    );
  }
  if (
    expected.resource &&
    typeof payload.resource === "string" &&
    payload.resource !== expected.resource
  ) {
    throw agentAuthError("invalid_grant", 400, "assertion resource mismatch");
  }

  const claims: ServiceAssertionClaims = {
    iss: String(payload.iss),
    aud: expected.audience,
    sub: payload.sub,
    jti: payload.jti,
    iat: typeof payload.iat === "number" ? payload.iat : 0,
    exp: typeof payload.exp === "number" ? payload.exp : 0,
    os_reg: String(payload.os_reg),
    os_claimed: payload.os_claimed === true,
    os_av: typeof payload.os_av === "number" ? payload.os_av : 0,
  };
  if (typeof payload.resource === "string") claims.resource = payload.resource;
  if (typeof payload.scope === "string") claims.scope = payload.scope;
  if (payload.act && typeof payload.act === "object" && "sub" in payload.act) {
    claims.act = { sub: String((payload.act as { sub: unknown }).sub) };
  }
  return claims;
}

export function peekAssertionTyp(jwt: string): string | undefined {
  try {
    return decodeHeader(jwt).typ;
  } catch {
    return undefined;
  }
}

export async function publicKeyFromJwk(jwk: JWK): Promise<VerifyKey> {
  return importJWK(jwk, jwk.alg);
}
