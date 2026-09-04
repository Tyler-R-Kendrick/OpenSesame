import { jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import {
  ID_JAG_ASSERTION_TYPE,
  PROVIDER_ID_JAG_TYP,
  SERVICE_ASSERTION_TYP,
} from "./constants.js";
import { agentAuthError } from "./errors.js";

type VerifyKey = CryptoKey | Uint8Array;

const ALLOWED_ALGS = new Set(["ES256", "RS256", "PS256"]);

export interface VerifiedProviderIdentity {
  issuer: string;
  subject: string;
  assertionId: string;
  issuedAt: Date;
  expiresAt: Date;
  authTime: Date;
  email?: string;
  emailVerified?: boolean;
  phoneNumber?: string;
  phoneNumberVerified?: boolean;
  clientId?: string;
}

export interface VerifyProviderIdJagInput {
  issuer: string;
  audiences: readonly string[];
  algorithms?: readonly string[];
  maxAgeSeconds: number;
  maxAuthAgeSeconds: number;
  getKey: (header: { kid?: string; alg?: string }) => Promise<VerifyKey>;
  now?: Date;
}

function decodeHeader(jwt: string): {
  typ?: string;
  alg?: string;
  kid?: string;
} {
  const headerB64 = jwt.split(".")[0];
  if (!headerB64) {
    throw agentAuthError("invalid_request", 400, "assertion is not a JWT");
  }
  try {
    return JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as {
      typ?: string;
      alg?: string;
      kid?: string;
    };
  } catch {
    throw agentAuthError("invalid_request", 400, "assertion is not a JWT");
  }
}

function normalizeIssuer(value: string): string {
  return value.replace(/\/+$/u, "");
}

/**
 * Verify a provider ID-JAG. Distinct from {@link verifyServiceAgentIdentityAssertion}:
 * different typ, issuer domain, and subject namespace (user sub, not areg_*).
 */
export async function verifyProviderIdJag(
  jwt: string,
  expected: VerifyProviderIdJagInput,
): Promise<VerifiedProviderIdentity> {
  const header = decodeHeader(jwt);
  if (header.typ === SERVICE_ASSERTION_TYP) {
    throw agentAuthError(
      "invalid_request",
      400,
      "service identity assertion is not a provider ID-JAG",
    );
  }
  if (header.typ !== PROVIDER_ID_JAG_TYP) {
    throw agentAuthError("invalid_request", 400, "unexpected assertion typ");
  }
  const alg = header.alg ?? "";
  const allowed = expected.algorithms?.length
    ? expected.algorithms
    : [...ALLOWED_ALGS];
  if (!ALLOWED_ALGS.has(alg) || !allowed.includes(alg)) {
    throw agentAuthError(
      "invalid_request",
      400,
      "rejected assertion algorithm",
    );
  }

  const key = await expected.getKey({
    ...(header.kid ? { kid: header.kid } : {}),
    alg,
  });
  const now = expected.now ?? new Date();
  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(jwt, key, {
      issuer: expected.issuer,
      audience: [...expected.audiences],
      algorithms: allowed.filter((item) => ALLOWED_ALGS.has(item)),
      currentDate: now,
      clockTolerance: 60,
    });
    payload = verified.payload;
  } catch (err) {
    if (err instanceof Error && err.name === "AgentAuthError") throw err;
    throw agentAuthError(
      "invalid_request",
      400,
      "assertion verification failed",
    );
  }

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw agentAuthError("invalid_request", 400, "assertion missing subject");
  }
  if (payload.sub.startsWith("areg_")) {
    throw agentAuthError(
      "invalid_request",
      400,
      "provider ID-JAG subject is not a user",
    );
  }
  if (typeof payload.jti !== "string" || payload.jti.length === 0) {
    throw agentAuthError("invalid_request", 400, "assertion missing jti");
  }
  if (typeof payload.exp !== "number") {
    throw agentAuthError("invalid_request", 400, "assertion missing exp");
  }
  if (typeof payload.iat !== "number") {
    throw agentAuthError("invalid_request", 400, "assertion missing iat");
  }
  const age = Math.floor(now.getTime() / 1000) - payload.iat;
  if (age > expected.maxAgeSeconds) {
    throw agentAuthError("invalid_request", 400, "assertion too old");
  }
  if (
    normalizeIssuer(String(payload.iss ?? "")) !==
    normalizeIssuer(expected.issuer)
  ) {
    throw agentAuthError("invalid_request", 400, "assertion issuer mismatch");
  }

  const maxAuthAge = expected.maxAuthAgeSeconds;
  if (typeof payload.auth_time !== "number") {
    throw agentAuthError(
      "login_required",
      401,
      "auth_time is missing. Re-authenticate at the provider and request a fresh ID-JAG.",
      { max_age: maxAuthAge },
    );
  }
  const authAge = Math.floor(now.getTime() / 1000) - payload.auth_time;
  if (authAge > maxAuthAge) {
    throw agentAuthError(
      "login_required",
      401,
      `auth_time is ${authAge}s old; max allowed is ${maxAuthAge}s. Re-authenticate at the provider and request a fresh ID-JAG.`,
      { max_age: maxAuthAge },
    );
  }

  const emailOk =
    payload.email_verified === true && typeof payload.email === "string";
  const phoneOk =
    payload.phone_number_verified === true &&
    typeof payload.phone_number === "string";
  if (!emailOk && !phoneOk) {
    throw agentAuthError(
      "invalid_request",
      400,
      "unverified identity: email_verified or phone_number_verified is required",
    );
  }

  const identity: VerifiedProviderIdentity = {
    issuer: normalizeIssuer(String(payload.iss)),
    subject: payload.sub,
    assertionId: payload.jti,
    issuedAt: new Date(payload.iat * 1000),
    expiresAt: new Date(payload.exp * 1000),
    authTime: new Date(payload.auth_time * 1000),
  };
  if (typeof payload.email === "string") identity.email = payload.email;
  if (payload.email_verified === true) identity.emailVerified = true;
  if (typeof payload.phone_number === "string") {
    identity.phoneNumber = payload.phone_number;
  }
  if (payload.phone_number_verified === true) {
    identity.phoneNumberVerified = true;
  }
  if (typeof payload.client_id === "string")
    identity.clientId = payload.client_id;
  return identity;
}

export function isIdJagAssertionType(value: string): boolean {
  return value === ID_JAG_ASSERTION_TYPE;
}

export { ID_JAG_ASSERTION_TYPE };
