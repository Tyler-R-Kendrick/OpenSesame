import { type KeyObject, createSign, generateKeyPairSync } from "node:crypto";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";

export function publicJwk(key: KeyObject, kid: string): JsonObject {
  const jwk = overlapCast(key.export({ format: "jwk" }));
  jwk.kid = kid;
  jwk.use = "sig";
  jwk.alg = "RS256";
  jwk.d = undefined;
  jwk.p = undefined;
  jwk.q = undefined;
  jwk.dp = undefined;
  jwk.dq = undefined;
  jwk.qi = undefined;
  return jwk;
}

export type RsaPair = {
  privateKey: KeyObject;
  jwk: JsonObject;
};

export function rsaPair(kid: string): RsaPair {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privateKey: pair.privateKey, jwk: publicJwk(pair.publicKey, kid) };
}

export function signJwt(
  key: KeyObject,
  header: JsonObject,
  payload: JsonObject,
): string {
  const head = Buffer.from(JSON.stringify(header)).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const data = `${head}.${body}`;
  const sig = createSign("RSA-SHA256").update(data).sign(key, "base64url");
  return `${data}.${sig}`;
}

export function clientAssertion(
  key: KeyObject,
  kid: string,
  clientId: string,
  aud: string,
  jti: string,
): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    key,
    { alg: "RS256", kid, typ: "JWT" },
    { iss: clientId, sub: clientId, aud, exp: now + 60, iat: now, jti },
  );
}

export type TokenResponse = {
  status: number;
  json: JsonObject;
};

export async function postToken(
  url: string,
  body: URLSearchParams,
): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return { status: res.status, json: overlapCast(await res.json()) };
}

export function ccBody(clientId: string, assertion: string): URLSearchParams {
  return new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_assertion_type:
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  });
}
