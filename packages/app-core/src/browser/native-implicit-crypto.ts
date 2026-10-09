/** Provider-return bearer material is encrypted to one ephemeral initiating browser session. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";

const opaque = z
  .string()
  .min(1)
  .max(32768)
  .regex(/^[!-~]+$/);
export const NativeImplicitTokenSchema = z
  .object({
    accessToken: opaque,
    tokenType: z.string().max(256),
    expiresIn: z
      .number()
      .finite()
      .positive()
      .max(365 * 86400)
      .nullable(),
    scopes: z.array(z.string().min(1).max(512)).max(256).nullable(),
    protocolValid: z.boolean().optional(),
  })
  .strict();
export const NativeImplicitPayloadSchema = z.union([
  NativeImplicitTokenSchema,
  z.object({ error: z.literal(true) }).strict(),
]);
export type NativeImplicitPayload = z.infer<typeof NativeImplicitPayloadSchema>;
export type NativeImplicitToken = z.infer<typeof NativeImplicitTokenSchema>;
const stateBody = z
  .object({
    v: z.literal(1),
    p: z.enum(["discord", "reddit", "google"]),
    n: z.string().min(32).max(128),
    k: z.string().length(87),
  })
  .strict();
const envelope = z
  .object({
    kind: z.literal("encrypted-provider-token"),
    state: z.string().max(512),
    publicKey: z.string().length(87),
    iv: z.string().length(16),
    ciphertext: z.string().min(16).max(262144),
  })
  .strict();
export type NativeImplicitEnvelope = z.infer<typeof envelope>;
export function encodeImplicitBytes(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function decode(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("Invalid encrypted authorization return");
  return Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (character) => character.charCodeAt(0),
  ).buffer;
}
export async function createNativeImplicitKey(
  providerId: "discord" | "reddit" | "google",
  nonce: string,
) {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const body = stateBody.parse({
    v: 1,
    p: providerId,
    n: nonce,
    k: encodeImplicitBytes(
      await crypto.subtle.exportKey("raw", keys.publicKey),
    ),
  });
  const state = `osimplicit1.${encodeImplicitBytes(new TextEncoder().encode(JSON.stringify(body)).buffer)}`;
  if (state.length > 512) throw new Error("Authorization state is too large");
  return { state, keys };
}
function binding(
  state: string,
  providerId: string,
  redirectUri: string,
): ArrayBuffer {
  return new TextEncoder().encode(
    JSON.stringify([state, providerId, redirectUri]),
  ).buffer;
}
export function parseNativeImplicitState(state: string) {
  if (state.length > 512 || !state.startsWith("osimplicit1."))
    throw new Error("Invalid encrypted authorization state");
  const value: BoundaryValue = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(decode(state.slice(12))),
  );
  return stateBody.parse(value);
}
async function key(
  privateKey: CryptoKey,
  publicPoint: string,
  aad: ArrayBuffer,
  receipt = false,
) {
  const publicKey = await crypto.subtle.importKey(
    "raw",
    decode(publicPoint),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256,
  );
  const material = await crypto.subtle.importKey("raw", bits, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: aad,
      info: new TextEncoder().encode(
        receipt
          ? "OpenSesame provider receipt v1"
          : "OpenSesame provider return v1",
      ),
    },
    material,
    receipt
      ? { name: "HMAC", hash: "SHA-256", length: 256 }
      : { name: "AES-GCM", length: 256 },
    false,
    receipt ? ["sign", "verify"] : ["encrypt", "decrypt"],
  );
}
export type NativeImplicitDelivery = {
  envelope: NativeImplicitEnvelope;
  receipt: string;
};
export async function encryptNativeImplicitDelivery(
  state: string,
  providerId: string,
  redirectUri: string,
  payload: NativeImplicitPayload,
): Promise<NativeImplicitDelivery> {
  const body = parseNativeImplicitState(state);
  if (body.p !== providerId)
    throw new Error("Provider return does not match the receiver");
  const sender = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const aad = binding(state, providerId, redirectUri);
  const aes = await key(sender.privateKey, body.k, aad);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    aes,
    new TextEncoder().encode(
      JSON.stringify(NativeImplicitPayloadSchema.parse(payload)),
    ),
  );
  const envelope: NativeImplicitEnvelope = {
    kind: "encrypted-provider-token",
    state,
    publicKey: encodeImplicitBytes(
      await crypto.subtle.exportKey("raw", sender.publicKey),
    ),
    iv: encodeImplicitBytes(iv.buffer),
    ciphertext: encodeImplicitBytes(ciphertext),
  };
  return {
    envelope,
    receipt: await nativeImplicitSecretReceipt(
      sender.privateKey,
      body.k,
      state,
      providerId,
      redirectUri,
      envelope,
    ),
  };
}
export async function nativeImplicitSecretReceipt(
  privateKey: CryptoKey,
  publicKey: string,
  state: string,
  providerId: string,
  redirectUri: string,
  wire: NativeImplicitEnvelope,
): Promise<string> {
  const signing = await key(
    privateKey,
    publicKey,
    binding(state, providerId, redirectUri),
    true,
  );
  return encodeImplicitBytes(
    await crypto.subtle.sign(
      "HMAC",
      signing,
      new TextEncoder().encode(wire.ciphertext),
    ),
  );
}
export async function encryptNativeImplicitPayload(
  state: string,
  providerId: string,
  redirectUri: string,
  payload: NativeImplicitPayload,
): Promise<NativeImplicitEnvelope> {
  return (
    await encryptNativeImplicitDelivery(state, providerId, redirectUri, payload)
  ).envelope;
}
export async function decryptNativeImplicitPayload(
  keys: CryptoKeyPair,
  state: string,
  providerId: string,
  redirectUri: string,
  value: NativeImplicitEnvelope,
): Promise<NativeImplicitPayload> {
  const wire = envelope.parse(value);
  if (wire.state !== state || parseNativeImplicitState(state).p !== providerId)
    throw new Error("Provider return does not match the receiver");
  const aad = binding(state, providerId, redirectUri);
  const aes = await key(keys.privateKey, wire.publicKey, aad);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decode(wire.iv), additionalData: aad },
    aes,
    decode(wire.ciphertext),
  );
  const body: BoundaryValue = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
  );
  return NativeImplicitPayloadSchema.parse(body);
}
