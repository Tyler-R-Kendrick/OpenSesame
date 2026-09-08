import {
  type BoundaryValue,
  isJsonObject,
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

export async function verifyBrowserIdToken(input: {
  token: string;
  nonce: string;
  issuer: string;
  clientId: string;
  jwksUri: string;
  fetchImpl: typeof fetch;
}): Promise<string> {
  if (!input.nonce || input.token.length > 16384)
    throw new Error("Invalid ID token transaction");
  const getKey = await readPublicJwks(input.fetchImpl, input.jwksUri);
  const { payload, protectedHeader } = await jwtVerify(input.token, getKey, {
    issuer: input.issuer,
    audience: input.clientId,
    algorithms: ["RS256", "ES256"],
    requiredClaims: ["iss", "aud", "sub", "exp", "iat", "nonce"],
    clockTolerance: 5,
    maxTokenAge: "10m",
  });
  if (protectedHeader.typ !== undefined && protectedHeader.typ !== "JWT")
    throw new Error("Invalid ID token type");
  if (
    protectedHeader.jku !== undefined ||
    protectedHeader.x5u !== undefined ||
    protectedHeader.jwk !== undefined
  )
    throw new Error("Embedded ID token key references refused");
  if (payload.nonce !== input.nonce) throw new Error("id_token nonce mismatch");
  if (!isString(payload.sub) || !payload.sub)
    throw new Error("id_token missing sub");
  // JOSE has decoded this field from the signed JSON payload, not an arbitrary object.
  const authorizedParty: BoundaryValue = overlapCast(payload.azp);
  if (authorizedParty !== undefined && !isString(authorizedParty))
    throw new Error("Invalid authorized party");
  assertAuthorizedParty(payload.aud, authorizedParty, input.clientId);
  return payload.sub;
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
