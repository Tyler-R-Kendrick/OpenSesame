import {
  type JSONWebKeySet,
  type JWTVerifyOptions,
  createLocalJWKSet,
  decodeProtectedHeader,
  jwtVerify,
} from "jose";
import { z } from "zod";
import { nativeApiHttp } from "./native-api-http.js";
import type { NativeConfiguration } from "./native-connector-schema.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  type NativeOriginOwner,
  ORIGIN_ISSUER,
  ORIGIN_JWKS_URL,
  assertNativeOriginPolicy,
  nativeOriginTarget,
} from "./native-origin-configuration.js";

const ReceiptHeader = z
  .object({
    alg: z.literal("EdDSA"),
    typ: z.literal("origin-installation-receipt+jwt"),
    kid: z.string().min(1),
  })
  .passthrough();
const Discovery = z
  .object({
    issuer: z.literal(ORIGIN_ISSUER),
    jwks_uri: z.literal(ORIGIN_JWKS_URL),
    id_token_signing_alg_values_supported: z.array(z.literal("EdDSA")),
  })
  .passthrough();
const Key = z
  .object({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    use: z.literal("sig"),
    alg: z.literal("EdDSA"),
    kid: z.string().min(1).max(256),
    x: z.string().min(1).max(4096),
  })
  .passthrough();
const Keys = z.object({ keys: z.array(Key).min(1).max(64) }).passthrough();
const Claims = z
  .object({
    sub: z.string().min(1).max(256),
    namespace_id: z.string().min(1).max(256),
    jti: z.string().min(1).max(256),
    state: z.string().min(1).max(512),
    iat: z.number().int(),
    exp: z.number().int(),
  })
  .passthrough();
type CacheEntry = {
  keys: JSONWebKeySet;
  freshUntil: number;
  staleUntil: number;
};
const cache = new Map<string, CacheEntry>();
async function fetchKeys(
  configuration: NativeConfiguration,
  owner: NativeOriginOwner,
): Promise<JSONWebKeySet> {
  const target = nativeOriginTarget(configuration);
  assertNativeOriginPolicy(configuration, owner, target.discovery_url);
  const discovery = Discovery.parse(
    await nativeApiHttp(
      {
        url: target.discovery_url,
        method: "GET",
        headers: new Headers({ accept: "application/json" }),
        signal: owner.transport.signal,
      },
      owner.transport,
    ),
  );
  assertNativeOriginPolicy(configuration, owner, discovery.jwks_uri);
  const parsed = Keys.parse(
    await nativeApiHttp(
      {
        url: discovery.jwks_uri,
        method: "GET",
        headers: new Headers({ accept: "application/json" }),
        signal: owner.transport.signal,
      },
      owner.transport,
    ),
  );
  if (new Set(parsed.keys.map((key) => key.kid)).size !== parsed.keys.length)
    throw new NativeOAuthError("provider");
  return { keys: parsed.keys };
}
async function keys(
  configuration: NativeConfiguration,
  owner: NativeOriginOwner,
  refresh: boolean,
): Promise<JSONWebKeySet> {
  const target = nativeOriginTarget(configuration);
  const now = Date.now();
  const held = cache.get(target.jwks_uri);
  if (!refresh && held && held.freshUntil > now) return held.keys;
  try {
    const loaded = await fetchKeys(configuration, owner);
    const entry = {
      keys: loaded,
      freshUntil: now + 600_000,
      staleUntil: now + 1_200_000,
    };
    cache.set(target.jwks_uri, entry);
    return loaded;
  } catch (error) {
    if (held && held.staleUntil > now) return held.keys;
    throw error;
  }
}
function invalid(): never {
  throw new NativeOAuthError("callback");
}
export async function verifyNativeOriginReceipt(
  receipt: string,
  expected: {
    configuration: NativeConfiguration;
    appId: string;
    state: string;
    owner: NativeOriginOwner;
  },
) {
  try {
    ReceiptHeader.parse(decodeProtectedHeader(receipt));
  } catch {
    return invalid();
  }
  const options: JWTVerifyOptions = {
    issuer: ORIGIN_ISSUER,
    audience: expected.appId,
    algorithms: ["EdDSA"],
    typ: "origin-installation-receipt+jwt",
    requiredClaims: ["sub", "namespace_id", "iat", "exp", "jti", "state"],
    maxTokenAge: "5m",
  };
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    const first = await keys(expected.configuration, expected.owner, false);
    try {
      payload = (await jwtVerify(receipt, createLocalJWKSet(first), options))
        .payload;
    } catch {
      const refreshed = await keys(
        expected.configuration,
        expected.owner,
        true,
      );
      payload = (
        await jwtVerify(receipt, createLocalJWKSet(refreshed), options)
      ).payload;
    }
  } catch {
    return invalid();
  }
  const claims = Claims.safeParse(payload);
  if (
    !claims.success ||
    claims.data.state !== expected.state ||
    claims.data.exp - claims.data.iat !== 300
  )
    return invalid();
  return {
    installationId: claims.data.sub,
    namespaceId: claims.data.namespace_id,
    receiptId: claims.data.jti,
  };
}
export function resetNativeOriginJwksCache(): void {
  cache.clear();
}
