/** Shared key material for the verifier suites. */
import { exportJWK, generateKeyPair } from "jose";

export const ISSUER = "http://127.0.0.1:8788";
export const AUDIENCE = "rp-alpha";

export async function mintKeys() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-1";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwks: { keys: [jwk] } };
}
