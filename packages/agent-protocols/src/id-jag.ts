import {
  type JsonObject,
  isNumber,
  isString,
  readString,
} from "@opensesame/os-domain";
import { decodeProtectedHeader, jwtVerify } from "jose";
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

type IdJagHeader = {
  typ?: string;
  alg?: string;
  kid?: string;
};

type IdJagTimes = {
  jti: string;
  iat: number;
  exp: number;
  authTime: number;
};

function decodeHeader(jwt: string): IdJagHeader {
  try {
    const header = decodeProtectedHeader(jwt);
    const result: IdJagHeader = {};
    if (isString(header.typ)) result.typ = header.typ;
    if (isString(header.alg)) result.alg = header.alg;
    if (isString(header.kid)) result.kid = header.kid;
    return result;
  } catch {
    throw agentAuthError("invalid_request", 400, "assertion is not a JWT");
  }
}

function normalizeIssuer(value: string): string {
  return value.replace(/\/+$/u, "");
}

function assertIdJagHeader(
  header: { typ?: string; alg?: string },
  expected: VerifyProviderIdJagInput,
): string {
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
  return alg;
}

function assertIdJagSubject(payload: JsonObject): string {
  const subject = readString(payload.sub);
  if (subject === undefined || subject.length === 0) {
    throw agentAuthError("invalid_request", 400, "assertion missing subject");
  }
  if (subject.startsWith("areg_")) {
    throw agentAuthError(
      "invalid_request",
      400,
      "provider ID-JAG subject is not a user",
    );
  }
  return subject;
}

function assertIdJagTimes(
  payload: JsonObject,
  expected: VerifyProviderIdJagInput,
  now: Date,
): IdJagTimes {
  const jti = readString(payload.jti);
  if (jti === undefined || jti.length === 0) {
    throw agentAuthError("invalid_request", 400, "assertion missing jti");
  }
  if (!isNumber(payload.exp)) {
    throw agentAuthError("invalid_request", 400, "assertion missing exp");
  }
  if (!isNumber(payload.iat)) {
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
  if (!isNumber(payload.auth_time)) {
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
  return {
    jti,
    iat: payload.iat,
    exp: payload.exp,
    authTime: payload.auth_time,
  };
}

function assertVerifiedContact(payload: JsonObject): void {
  const emailOk =
    payload.email_verified === true && isString(payload.email);
  const phoneOk =
    payload.phone_number_verified === true && isString(payload.phone_number);
  if (!emailOk && !phoneOk) {
    throw agentAuthError(
      "invalid_request",
      400,
      "unverified identity: email_verified or phone_number_verified is required",
    );
  }
}

function toVerifiedIdentity(
  payload: JsonObject,
  subject: string,
  times: IdJagTimes,
): VerifiedProviderIdentity {
  const identity: VerifiedProviderIdentity = {
    issuer: normalizeIssuer(String(payload.iss)),
    subject,
    assertionId: times.jti,
    issuedAt: new Date(times.iat * 1000),
    expiresAt: new Date(times.exp * 1000),
    authTime: new Date(times.authTime * 1000),
  };
  const email = readString(payload.email);
  if (email !== undefined) identity.email = email;
  if (payload.email_verified === true) identity.emailVerified = true;
  const phoneNumber = readString(payload.phone_number);
  if (phoneNumber !== undefined) identity.phoneNumber = phoneNumber;
  if (payload.phone_number_verified === true) {
    identity.phoneNumberVerified = true;
  }
  const clientId = readString(payload.client_id);
  if (clientId !== undefined) identity.clientId = clientId;
  return identity;
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
  const alg = assertIdJagHeader(header, expected);
  const allowed = expected.algorithms?.length
    ? expected.algorithms
    : [...ALLOWED_ALGS];
  const keyHeader: Parameters<typeof expected.getKey>[0] = { alg };
  if (header.kid) keyHeader.kid = header.kid;
  const key = await expected.getKey(keyHeader);
  const now = expected.now ?? new Date();
  let payload: JsonObject;
  try {
    const verified = await jwtVerify<JsonObject>(jwt, key, {
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

  const subject = assertIdJagSubject(payload);
  const times = assertIdJagTimes(payload, expected, now);
  assertVerifiedContact(payload);
  return toVerifiedIdentity(payload, subject, times);
}

export function isIdJagAssertionType(value: string): boolean {
  return value === ID_JAG_ASSERTION_TYPE;
}

export { ID_JAG_ASSERTION_TYPE };
