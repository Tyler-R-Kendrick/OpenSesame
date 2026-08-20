import { type JWK, SignJWT, exportJWK, generateKeyPair } from "jose";

export interface TestSigningKey {
  privateKey: CryptoKey;
  publicJwk: JWK;
  jwks: { keys: JWK[] };
}

export async function createTestSigningKey(
  alg: "RS256" | "ES256" = "RS256",
): Promise<TestSigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg);
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = alg;
  publicJwk.use = "sig";
  publicJwk.kid = "test-signing-key";
  return {
    privateKey,
    publicJwk,
    jwks: { keys: [publicJwk] },
  };
}

export async function mintTestIdToken(
  signingKey: TestSigningKey,
  claims: {
    sub: string;
    nonce: string;
    iss: string;
    aud: string;
    exp?: string;
  },
  alg: "RS256" | "ES256" = "RS256",
): Promise<string> {
  const kid = signingKey.publicJwk.kid ?? "test-signing-key";
  let builder = new SignJWT({ nonce: claims.nonce })
    .setProtectedHeader({ alg, kid })
    .setSubject(claims.sub)
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setIssuedAt();
  builder = builder.setExpirationTime(claims.exp ?? "1h");
  return builder.sign(signingKey.privateKey);
}
