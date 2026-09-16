import { exportJWK, generateKeyPair } from "jose";
import { exportPublicEcP256Jwk } from "./id-token.js";

export async function p256Pair() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const publicJwk = await exportPublicEcP256Jwk(publicKey);
  const privateJwk = await exportJWK(privateKey);
  return { privateKey, publicKey, publicJwk, privateJwk };
}
