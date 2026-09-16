/**
 * Self-Issued ID Token builder and RP verifier.
 */

import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { type JWK, SignJWT, exportJWK, importJWK, jwtVerify } from "jose";
import { readAudience } from "./audience.js";
import { constantTimeEquals } from "./encoding.js";
import { guardedAsync, refuse } from "./errors.js";
import { type SiopIssuerProfile, resolveIssuer } from "./issuer.js";
import { readSignedCompactJws } from "./jose.js";
import {
  type EcP256PublicJwk,
  ecP256JwkThumbprint,
  parsePublicEcP256Jwk,
} from "./jwk.js";
import {
  DEFAULT_CLOCK_SKEW_SECONDS,
  DEFAULT_ID_TOKEN_TTL_SECONDS,
  DEFAULT_MAX_IAT_AGE_SECONDS,
  MAX_CLOCK_SKEW_SECONDS,
  MAX_EPOCH_SECONDS,
  MAX_ID_TOKEN_CHARS,
  MAX_ID_TOKEN_TTL_SECONDS,
  MAX_MAX_IAT_AGE_SECONDS,
  MIN_EPOCH_SECONDS,
  clampNonNegativeInt,
} from "./limits.js";
import {
  assertIAmSiopClaim,
  assertTokenFreshness,
  readEpoch,
} from "./validity.js";

export {
  STATIC_SELF_ISSUED_ISSUER,
  type SiopIssuerProfile,
} from "./issuer.js";

export type SigningKey = CryptoKey | JWK;

export interface BuildSelfIssuedIdTokenInput {
  readonly profile: SiopIssuerProfile;
  readonly audience: string;
  readonly nonce: string;
  readonly publicJwk: EcP256PublicJwk;
  readonly signingKey: SigningKey;
  readonly ttlSeconds?: number;
  readonly nowSeconds?: number;
}

export interface VerifiedSelfIssuedIdToken {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly nonce: string;
  readonly exp: number;
  readonly iat: number;
  readonly iAmSiop: boolean;
  readonly subJwk: EcP256PublicJwk;
  readonly profile: SiopIssuerProfile["kind"];
}

export interface VerifySelfIssuedIdTokenInput {
  readonly idToken: string;
  readonly expectedAudience: string;
  readonly expectedNonce: string;
  readonly profile: SiopIssuerProfile;
  readonly clockSkewSeconds?: number;
  readonly maxIatAgeSeconds?: number;
  readonly nowSeconds?: number;
}

function publicJwkToJson(jwk: EcP256PublicJwk): JsonObject {
  const json: JsonObject = {
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  };
  if (jwk.kid !== undefined) json.kid = jwk.kid;
  if (jwk.alg !== undefined) json.alg = jwk.alg;
  if (jwk.use !== undefined) json.use = jwk.use;
  return json;
}

function publicJwkToJose(jwk: EcP256PublicJwk): JWK {
  const joseJwk: JWK = {
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  };
  if (jwk.kid !== undefined) joseJwk.kid = jwk.kid;
  if (jwk.alg !== undefined) joseJwk.alg = jwk.alg;
  if (jwk.use !== undefined) joseJwk.use = jwk.use;
  return joseJwk;
}

export async function buildSelfIssuedIdToken(
  input: BuildSelfIssuedIdTokenInput,
): Promise<string> {
  if (input.audience.length === 0 || input.nonce.length === 0) {
    refuse("malformed_request", "id_token_build");
  }
  const ttl = clampNonNegativeInt(
    input.ttlSeconds,
    DEFAULT_ID_TOKEN_TTL_SECONDS,
    MAX_ID_TOKEN_TTL_SECONDS,
  );
  if (ttl < 0) refuse("limit_exceeded", "limits");
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (
    !Number.isInteger(now) ||
    now < MIN_EPOCH_SECONDS ||
    now > MAX_EPOCH_SECONDS
  ) {
    refuse("limit_exceeded", "limits");
  }
  const publicJwk = parsePublicEcP256Jwk(
    publicJwkToJson(input.publicJwk),
    "sub_jwk",
  );
  const sub = await ecP256JwkThumbprint(publicJwk);
  const { iss, iAmSiop } = resolveIssuer(input.profile);
  const claims: JsonObject = {
    iss,
    sub,
    aud: input.audience,
    nonce: input.nonce,
    exp: now + ttl,
    iat: now,
    sub_jwk: publicJwkToJson(publicJwk),
  };
  if (iAmSiop) claims.i_am_siop = true;
  const compact = await guardedAsync(
    "id_token_build",
    "malformed_id_token",
    async () =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "ES256" })
        .sign(input.signingKey),
  );
  if (compact.length > MAX_ID_TOKEN_CHARS) refuse("limit_exceeded", "limits");
  return compact;
}

export async function verifySelfIssuedIdToken(
  input: VerifySelfIssuedIdTokenInput,
): Promise<VerifiedSelfIssuedIdToken> {
  if (input.idToken.length > MAX_ID_TOKEN_CHARS) {
    refuse("limit_exceeded", "limits");
  }
  if (input.idToken.length === 0) {
    refuse("malformed_id_token", "id_token_verify");
  }
  const skew = clampNonNegativeInt(
    input.clockSkewSeconds,
    DEFAULT_CLOCK_SKEW_SECONDS,
    MAX_CLOCK_SKEW_SECONDS,
  );
  if (skew < 0) refuse("limit_exceeded", "limits");
  const maxIatAge = clampNonNegativeInt(
    input.maxIatAgeSeconds,
    DEFAULT_MAX_IAT_AGE_SECONDS,
    MAX_MAX_IAT_AGE_SECONDS,
  );
  if (maxIatAge < 0) refuse("limit_exceeded", "limits");
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (
    !Number.isInteger(now) ||
    now < MIN_EPOCH_SECONDS ||
    now > MAX_EPOCH_SECONDS
  ) {
    refuse("limit_exceeded", "limits");
  }
  const checked = readSignedCompactJws(input.idToken, "id_token_verify");
  const payload = checked.payload;
  const expected = resolveIssuer(input.profile);
  const iss = payload.iss;
  if (!isString(iss) || !constantTimeEquals(iss, expected.iss)) {
    refuse("issuer_mismatch", "issuer_profile");
  }
  assertIAmSiopClaim(expected.iAmSiop, payload.i_am_siop);
  const subJwkRaw = payload.sub_jwk;
  if (!isJsonObject(subJwkRaw)) refuse("invalid_sub_jwk", "sub_jwk");
  const subJwk = parsePublicEcP256Jwk(subJwkRaw, "sub_jwk");
  const thumbprint = await ecP256JwkThumbprint(subJwk);
  const sub = payload.sub;
  if (!isString(sub) || !constantTimeEquals(sub, thumbprint)) {
    refuse("subject_mismatch", "thumbprint");
  }
  const aud = readAudience(payload, input.expectedAudience);
  const nonce = payload.nonce;
  if (!isString(nonce) || !constantTimeEquals(nonce, input.expectedNonce)) {
    refuse("nonce_mismatch", "nonce_binding");
  }
  const exp = readEpoch(payload, "exp");
  const iat = readEpoch(payload, "iat");
  assertTokenFreshness({ exp, iat, now, skew, maxIatAge });
  await guardedAsync("id_token_verify", "signature_invalid", async () => {
    const key = await importJWK(publicJwkToJose(subJwk), "ES256");
    await jwtVerify(checked.compact, key, {
      algorithms: ["ES256"],
      currentDate: new Date((now + skew + 1) * 1000),
    });
  });
  return {
    iss,
    sub,
    aud,
    nonce,
    exp,
    iat,
    iAmSiop: expected.iAmSiop,
    subJwk,
    profile: input.profile.kind,
  };
}

export async function exportPublicEcP256Jwk(
  key: CryptoKey,
): Promise<EcP256PublicJwk> {
  return await guardedAsync("sub_jwk", "invalid_sub_jwk", async () => {
    const jwk = await exportJWK(key);
    const publicOnly: JsonObject = {};
    if (isString(jwk.kty)) publicOnly.kty = jwk.kty;
    if (isString(jwk.crv)) publicOnly.crv = jwk.crv;
    if (isString(jwk.x)) publicOnly.x = jwk.x;
    if (isString(jwk.y)) publicOnly.y = jwk.y;
    if (isString(jwk.kid)) publicOnly.kid = jwk.kid;
    if (jwk.alg === "ES256") publicOnly.alg = "ES256";
    if (jwk.use === "sig") publicOnly.use = "sig";
    // SAFETY: JsonObject is a JsonValue.
    const asJson: JsonValue = publicOnly;
    return parsePublicEcP256Jwk(asJson, "sub_jwk");
  });
}
