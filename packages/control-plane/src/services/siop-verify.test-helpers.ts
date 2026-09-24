import { isString, isTypeofObject, overlapCast } from "@opensesame/os-domain";
import {
  type BuildSelfIssuedIdTokenInput,
  STATIC_SELF_ISSUED_ISSUER,
  type SiopIssuerProfile,
  buildSelfIssuedIdToken,
  exportPublicEcP256Jwk,
} from "@opensesame/siop-v2";
import { generateKeyPair } from "jose";
import { expect } from "vitest";
import type { createControlPlane } from "../create-app.js";

export const DYNAMIC_ISSUER = "https://identity.example/siop";
export const AUDIENCE = "https://id.example/siop-bridge";

export async function es256Pair() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const publicJwk = await exportPublicEcP256Jwk(publicKey);
  return { privateKey, publicJwk };
}

type MintTokenInput = {
  privateKey: CryptoKey;
  publicJwk: Awaited<ReturnType<typeof exportPublicEcP256Jwk>>;
  audience: string;
  nonce: string;
  profile: SiopIssuerProfile;
  nowSeconds?: number;
};

export async function mintToken(opts: MintTokenInput) {
  const baseInput: BuildSelfIssuedIdTokenInput = {
    profile: opts.profile,
    audience: opts.audience,
    nonce: opts.nonce,
    publicJwk: opts.publicJwk,
    signingKey: opts.privateKey,
  };
  if (opts.nowSeconds === undefined) {
    return buildSelfIssuedIdToken(baseInput);
  }
  return buildSelfIssuedIdToken({
    ...baseInput,
    nowSeconds: opts.nowSeconds,
  });
}

export async function guestPrincipal(
  app: ReturnType<typeof createControlPlane>["app"],
) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  const body = overlapCast(await res.json());
  if (
    !isTypeofObject(body) ||
    !("principalId" in body) ||
    !isString(body.principalId)
  ) {
    throw new Error("unexpected provisional response");
  }
  return body.principalId;
}

export { STATIC_SELF_ISSUED_ISSUER };
