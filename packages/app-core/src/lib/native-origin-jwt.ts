import { SignJWT } from "jose";

export type NativeOriginAppJwt = {
  token: string;
  issuedAt: number;
  expiresAt: number;
};
export async function createNativeOriginAppJwt(
  appId: string,
  privateKey: CryptoKey,
  now = Date.now(),
): Promise<NativeOriginAppJwt> {
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + 300;
  const token = await new SignJWT()
    .setProtectedHeader({ alg: "EdDSA", kid: appId, typ: "JWT" })
    .setIssuer(appId)
    .setAudience("origin-apps")
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(privateKey);
  return { token, issuedAt: issuedAt * 1000, expiresAt: expiresAt * 1000 };
}
