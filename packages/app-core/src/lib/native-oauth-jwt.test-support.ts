import type { JsonObject } from "@opensesame/os-domain";
import { base64UrlEncode } from "@opensesame/sdk-browser";

export const microsoftTenant = "11111111-1111-4111-8111-111111111111";
export const microsoftAccount = "22222222-2222-4222-8222-222222222222";
function part(value: JsonObject): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}
export async function microsoftAssertion(
  nonce: string,
  overrides: JsonObject = {},
) {
  const key = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", key.publicKey);
  const now = Math.floor(Date.now() / 1000);
  const encoded = `${part({ alg: "ES256", kid: "native-ms-signature" })}.${part({ iss: `https://login.microsoftonline.com/${microsoftTenant}/v2.0`, tid: microsoftTenant, oid: microsoftAccount, sub: "signed-provider-subject", aud: "public-browser-client", nonce, iat: now, exp: now + 300, ...overrides })}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key.privateKey,
    new TextEncoder().encode(encoded),
  );
  return {
    token: `${encoded}.${base64UrlEncode(new Uint8Array(signature))}`,
    jwks: {
      keys: [
        {
          kty: jwk.kty ?? "",
          crv: jwk.crv ?? "",
          x: jwk.x ?? "",
          y: jwk.y ?? "",
          use: "sig",
          alg: "ES256",
          kid: "native-ms-signature",
        },
      ],
    },
  };
}
