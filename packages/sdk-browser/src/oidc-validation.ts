import {
  type BoundaryObject,
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { createLocalJWKSet, jwtVerify } from "jose";

/** The deadline covers headers and streamed bytes; no redirect or ambient cookies. */
export async function fetchOidcJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
) {
  const timeout = AbortSignal.timeout(10_000);
  const deadline = init.signal
    ? AbortSignal.any([init.signal, timeout])
    : timeout;
  const response = await fetchImpl(url, {
    ...init,
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    signal: deadline,
  });
  if (!response.ok || response.redirected)
    throw new Error("OIDC response refused");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("OIDC response missing body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel();
  };
  deadline.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      deadline.throwIfAborted();
      const part = await reader.read();
      deadline.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 262144) throw new Error("OIDC response too large");
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const result: import("@opensesame/os-domain").BoundaryValue = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!isJsonObject(result))
      throw new Error("OIDC response is not an object");
    return result;
  } finally {
    deadline.removeEventListener("abort", cancel);
    await reader.cancel();
  }
}

async function readPublicJwks(fetchImpl: typeof fetch, uri: string) {
  const jwks = await fetchOidcJson(fetchImpl, uri);
  if (
    !Array.isArray(jwks.keys) ||
    jwks.keys.length === 0 ||
    jwks.keys.length > 32
  )
    throw new Error("Invalid JWKS key count");
  const seenKids = new Set<string>();
  for (const key of jwks.keys) validatePublicKey(key, seenKids);
  // JOSE performs key-type/algorithm/curve/modulus and signature validation.
  return createLocalJWKSet(overlapCast(jwks));
}

function validatePublicKey(key: BoundaryValue, seenKids: Set<string>) {
  if (!isJsonObject(key)) throw new Error("Invalid public JWK");
  if (
    ["d", "k", "p", "q", "dp", "dq", "qi", "oth", "jku", "x5u", "jwk"].some(
      (name) => key[name] !== undefined,
    )
  )
    throw new Error("JWKS must contain public keys without remote references");
  if (key.kid === undefined) return;
  if (
    !isString(key.kid) ||
    !key.kid ||
    key.kid.length > 128 ||
    seenKids.has(key.kid)
  )
    throw new Error("Invalid or duplicate JWK identifier");
  seenKids.add(key.kid);
}

export type VerifiedIdTokenClaims = {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  azp?: string;
  auth_time?: number;
  tid?: string;
  oid?: string;
  name?: string;
  email?: string;
};

export type VerifyBrowserIdTokenInput = {
  token: string;
  nonce: string;
  issuer: string;
  clientId: string;
  jwksUri: string;
  fetchImpl: typeof fetch;
};

export type VerifyRestoredIdTokenInput = {
  token: string;
  issuer: string;
  clientId: string;
  jwksUri: string;
  fetchImpl: typeof fetch;
};

export async function verifyBrowserIdToken(
  input: VerifyBrowserIdTokenInput,
): Promise<string> {
  const claims = await verifyBrowserIdTokenClaims(input);
  return claims.sub;
}

/**
 * Strict ID-token verification for a fresh ambient/OIDC transaction.
 * The expected nonce comes from the initiating transaction, never from the
 * token copied into its own expected-value field.
 */
export async function verifyBrowserIdTokenClaims(
  input: VerifyBrowserIdTokenInput,
): Promise<VerifiedIdTokenClaims> {
  if (!input.nonce || input.token.length > 16384)
    throw new Error("Invalid ID token transaction");
  return verifySignedIdToken({
    ...input,
    expectedNonce: input.nonce,
    maxTokenAge: "10m",
    requiredClaims: ["iss", "aud", "sub", "exp", "iat", "nonce"],
  });
}

/**
 * Re-validate a persisted assertion. Does not apply the ten-minute new-token
 * age rule and does not perform a nonce ceremony. Expiry still comes from
 * the signed `exp`, not from mutable JSON.
 */
export async function verifyRestoredBrowserIdToken(
  input: VerifyRestoredIdTokenInput,
): Promise<VerifiedIdTokenClaims> {
  if (input.token.length > 16384)
    throw new Error("Invalid ID token transaction");
  return verifySignedIdToken({
    ...input,
    expectedNonce: undefined,
    maxTokenAge: undefined,
    requiredClaims: ["iss", "aud", "sub", "exp", "iat"],
  });
}

type VerifySignedIdTokenInput = {
  token: string;
  issuer: string;
  clientId: string;
  jwksUri: string;
  fetchImpl: typeof fetch;
  expectedNonce: string | undefined;
  maxTokenAge: string | undefined;
  requiredClaims: string[];
};

type IdTokenPayloadFields = {
  iss: string;
  sub: string;
  aud: BoundaryValue;
  exp: number;
  iat: number;
  nonce?: BoundaryValue;
  tid?: BoundaryValue;
  oid?: BoundaryValue;
  name?: BoundaryValue;
  email?: BoundaryValue;
  auth_time?: BoundaryValue;
};

async function verifySignedIdToken(
  input: VerifySignedIdTokenInput,
): Promise<VerifiedIdTokenClaims> {
  const getKey = await readPublicJwks(input.fetchImpl, input.jwksUri);
  const { payload, protectedHeader } = await jwtVerify(input.token, getKey, {
    issuer: input.issuer,
    audience: input.clientId,
    algorithms: ["RS256", "ES256"],
    requiredClaims: input.requiredClaims,
    clockTolerance: 5,
    ...(input.maxTokenAge ? { maxTokenAge: input.maxTokenAge } : undefined),
  });
  assertProtectedHeader(protectedHeader);
  if (
    input.expectedNonce !== undefined &&
    payload.nonce !== input.expectedNonce
  )
    throw new Error("id_token nonce mismatch");
  if (!isString(payload.sub) || !payload.sub)
    throw new Error("id_token missing sub");
  if (
    !isString(payload.iss) ||
    !isNumber(payload.exp) ||
    !isNumber(payload.iat)
  )
    throw new Error("id_token missing required claims");
  const authorizedParty: BoundaryValue = overlapCast(payload.azp);
  if (authorizedParty !== undefined && !isString(authorizedParty))
    throw new Error("Invalid authorized party");
  assertAuthorizedParty(payload.aud, authorizedParty, input.clientId);
  const claims: BoundaryObject = overlapCast(payload);
  return claimsFromPayload(
    {
      iss: payload.iss,
      sub: payload.sub,
      aud: overlapCast(payload.aud),
      exp: payload.exp,
      iat: payload.iat,
      nonce: overlapCast(payload.nonce),
      tid: claims.tid,
      oid: claims.oid,
      name: overlapCast(payload.name),
      email: overlapCast(payload.email),
      auth_time: overlapCast(payload.auth_time),
    },
    isString(authorizedParty) ? authorizedParty : undefined,
  );
}

function assertProtectedHeader(header: {
  typ?: unknown;
  jku?: unknown;
  x5u?: unknown;
  jwk?: unknown;
}) {
  if (header.typ !== undefined && header.typ !== "JWT")
    throw new Error("Invalid ID token type");
  if (
    header.jku !== undefined ||
    header.x5u !== undefined ||
    header.jwk !== undefined
  )
    throw new Error("Embedded ID token key references refused");
}

function claimsFromPayload(
  payload: IdTokenPayloadFields,
  authorizedParty: string | undefined,
): VerifiedIdTokenClaims {
  const tid = payload.tid;
  const oid = payload.oid;
  const name = payload.name;
  const email = payload.email;
  const authTime = payload.auth_time;
  const nonce = payload.nonce;
  const audRaw = payload.aud;
  let aud: string | string[];
  if (isString(audRaw)) {
    aud = audRaw;
  } else if (Array.isArray(audRaw)) {
    const parts: string[] = [];
    for (const item of audRaw) {
      if (!isString(item)) throw new Error("id_token missing aud");
      parts.push(item);
    }
    aud = parts;
  } else {
    throw new Error("id_token missing aud");
  }
  return {
    iss: payload.iss,
    sub: payload.sub,
    aud,
    exp: payload.exp,
    iat: payload.iat,
    ...(isString(nonce) ? { nonce } : undefined),
    ...(isString(authorizedParty) ? { azp: authorizedParty } : undefined),
    ...(isNumber(authTime) ? { auth_time: authTime } : undefined),
    ...(isString(tid) ? { tid } : undefined),
    ...(isString(oid) ? { oid } : undefined),
    ...(isString(name) ? { name } : undefined),
    ...(isString(email) ? { email } : undefined),
  };
}

function assertAuthorizedParty(
  audience: string | string[] | undefined,
  authorizedParty: string | undefined,
  clientId: string,
) {
  if (
    Array.isArray(audience) &&
    audience.length > 1 &&
    authorizedParty !== clientId
  )
    throw new Error("id_token authorized party mismatch");
  if (authorizedParty !== undefined && authorizedParty !== clientId)
    throw new Error("id_token authorized party mismatch");
}
