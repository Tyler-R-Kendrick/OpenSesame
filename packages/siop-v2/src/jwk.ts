/**
 * Public EC P-256 JWK validation and RFC 7638 thumbprints.
 */

import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { encodeBase64url, encodeUtf8, isBase64url } from "./encoding.js";
import { type SiopV2Checkpoint, refuse } from "./errors.js";

export const SUBJECT_SYNTAX_JWK_THUMBPRINT =
  "urn:ietf:params:oauth:jwk-thumbprint" as const;

export const EC_P256_KTY = "EC" as const;
export const EC_P256_CRV = "P-256" as const;

export interface EcP256PublicJwk {
  readonly kty: typeof EC_P256_KTY;
  readonly crv: typeof EC_P256_CRV;
  readonly x: string;
  readonly y: string;
  readonly kid?: string;
  readonly alg?: "ES256";
  readonly use?: "sig";
}

function refuseJwk(checkpoint: SiopV2Checkpoint): never {
  refuse("invalid_sub_jwk", checkpoint);
}

export function parsePublicEcP256Jwk(
  value: JsonValue,
  checkpoint: SiopV2Checkpoint = "sub_jwk",
): EcP256PublicJwk {
  if (!isJsonObject(value)) refuseJwk(checkpoint);

  if (value.d !== undefined) refuseJwk(checkpoint);
  if (value.kty !== EC_P256_KTY) refuseJwk(checkpoint);
  if (value.crv !== EC_P256_CRV) refuseJwk(checkpoint);
  if (!isString(value.x) || !isBase64url(value.x)) refuseJwk(checkpoint);
  if (!isString(value.y) || !isBase64url(value.y)) refuseJwk(checkpoint);

  if (
    value.x5c !== undefined ||
    value.x5u !== undefined ||
    value.x5t !== undefined ||
    value["x5t#S256"] !== undefined
  ) {
    refuseJwk(checkpoint);
  }

  if (value.alg !== undefined && value.alg !== "ES256") refuseJwk(checkpoint);
  if (value.use !== undefined && value.use !== "sig") refuseJwk(checkpoint);
  if (value.kid !== undefined && !isString(value.kid)) refuseJwk(checkpoint);

  const jwk: EcP256PublicJwk = {
    kty: EC_P256_KTY,
    crv: EC_P256_CRV,
    x: value.x,
    y: value.y,
  };
  if (isString(value.kid)) {
    return finishOptionalFields(jwk, value.kid, value.alg, value.use);
  }
  return finishOptionalFields(jwk, undefined, value.alg, value.use);
}

function finishOptionalFields(
  base: EcP256PublicJwk,
  kid: string | undefined,
  alg: JsonValue | undefined,
  use: JsonValue | undefined,
): EcP256PublicJwk {
  let result = base;
  if (kid !== undefined) {
    result = { ...result, kid };
  }
  if (alg === "ES256") {
    result = { ...result, alg: "ES256" };
  }
  if (use === "sig") {
    result = { ...result, use: "sig" };
  }
  return result;
}

export async function ecP256JwkThumbprint(
  jwk: EcP256PublicJwk,
): Promise<string> {
  const canonical: JsonObject = {
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  };
  const text = JSON.stringify(canonical);
  const digest = await crypto.subtle.digest("SHA-256", encodeUtf8(text));
  return encodeBase64url(new Uint8Array(digest));
}
