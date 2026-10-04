/**
 * Genuine device identity key records for the tests that move a key between
 * a tomb and a vault body: a real P-256 pair, its real thumbprint, and the
 * time a test chooses, so "older" and "newer" are set rather than raced.
 */

import type { JsonObject } from "@opensesame/os-domain";
import {
  type DeviceIdentityKeyRecord,
  deviceKeyField,
} from "@opensesame/vault-core";
import { p256JwkThumbprint } from "../device-identity-key.js";

export async function genuineRecord(
  createdAt: number,
): Promise<DeviceIdentityKeyRecord> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = {
    kty: "EC",
    crv: "P-256",
    x: String(pub.x),
    y: String(pub.y),
  } as const;
  return {
    version: 1,
    keyId: await p256JwkThumbprint(publicJwk),
    publicJwk,
    privateJwkJson: JSON.stringify({ ...publicJwk, d: priv.d, alg: "ES256" }),
    createdAt,
  };
}

export async function genuineField(createdAt: number): Promise<JsonObject> {
  return deviceKeyField(await genuineRecord(createdAt));
}
