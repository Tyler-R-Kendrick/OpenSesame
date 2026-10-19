/** Bounded transport messages; none of these messages establishes SAML authentication. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import {
  type SamlPostOwner,
  assertSamlPostOwner,
} from "./assertion-conditions.js";
export {
  type SamlPostOwner,
  assertSamlPostOwner,
} from "./assertion-conditions.js";

export const SAML_POST_BYTES = 262144;
export const SamlNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const point = z.string().regex(/^[A-Za-z0-9_-]{87}$/);
const client = z.string().min(1).max(128);
const request = z.string().regex(/^_[A-Za-z0-9_.-]{1,255}$/);
export const SamlPostArmSchema = z
  .object({
    kind: z.literal("SAML_ARM"),
    nonce: SamlNonceSchema,
    requestId: request,
    expiresAt: z.number().int().positive(),
    idpOrigin: z.string().url().max(2048),
    publicKey: point,
  })
  .strict();
export const SamlPostRecordSchema = z
  .object({
    nonce: SamlNonceSchema,
    requestId: request,
    expiresAt: z.number().int().positive(),
    acsUrl: z.string().url().max(2048),
    recordId: client,
    publicKey: point,
  })
  .strict();
export type SamlPostRecord = z.infer<typeof SamlPostRecordSchema>;
export const SamlPostCommandSchema = z.union([
  SamlPostArmSchema,
  z.object({ kind: z.literal("SAML_CANCEL"), nonce: SamlNonceSchema }).strict(),
  z.object({ kind: z.literal("SAML_METADATA") }).strict(),
  z
    .object({
      kind: z.enum(["SAML_CLAIM", "SAML_CONSUME"]),
      nonce: SamlNonceSchema,
      recordId: client,
    })
    .strict(),
]);
export const SamlPostReplySchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(["missing", "denied", "capacity", "malformed"]),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      record: SamlPostRecordSchema.optional(),
      response: z
        .string()
        .max(SAML_POST_BYTES * 2)
        .optional(),
    })
    .strict(),
]);
export type SamlPostReply = z.infer<typeof SamlPostReplySchema>;
const binding = { nonce: SamlNonceSchema, recordId: client };
export const SamlPostChannelSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hello"), ...binding, publicKey: point }).strict(),
  z
    .object({ kind: z.literal("ready"), ...binding, mac: SamlNonceSchema })
    .strict(),
  z
    .object({
      kind: z.literal("payload"),
      ...binding,
      publicKey: point,
      iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
      ciphertext: z
        .string()
        .min(22)
        .max(524288)
        .regex(/^[A-Za-z0-9_-]+$/),
    })
    .strict(),
  z
    .object({ kind: z.literal("received"), ...binding, mac: SamlNonceSchema })
    .strict(),
]);
export type SamlPostChannel = z.infer<typeof SamlPostChannelSchema>;
export function samlPostBytes(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let text = "";
  for (let index = 0; index < bytes.length; index += 32768)
    text += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return btoa(text).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
export function samlPostDecode(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("Malformed SAML transport encoding");
  return Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (character) => character.charCodeAt(0),
  ).buffer;
}
export function samlPostChannel(nonce: string): BroadcastChannel {
  return new BroadcastChannel(
    `opensesame.saml.post.${SamlNonceSchema.parse(nonce)}`,
  );
}
export function samlPostBinding(
  record: SamlPostRecord,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify([
      "OpenSesame SAML POST v1",
      record.nonce,
      record.requestId,
      record.expiresAt,
      record.acsUrl,
      record.recordId,
      record.publicKey,
    ]),
  );
}
export type SamlPostKeys = Readonly<{ aes: CryptoKey; receipt: CryptoKey }>;
export async function samlPostKeys(
  privateKey: CryptoKey,
  peer: string,
  record: SamlPostRecord,
  owner: SamlPostOwner,
): Promise<SamlPostKeys> {
  assertSamlPostOwner(owner);
  const publicKey = await crypto.subtle.importKey(
    "raw",
    samlPostDecode(point.parse(peer)),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  assertSamlPostOwner(owner);
  const bits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256,
  );
  assertSamlPostOwner(owner);
  const material = await crypto.subtle.importKey("raw", bits, "HKDF", false, [
    "deriveKey",
  ]);
  assertSamlPostOwner(owner);
  const parameters = {
    name: "HKDF",
    hash: "SHA-256",
    salt: samlPostBinding(record),
  };
  const aes = await crypto.subtle.deriveKey(
    { ...parameters, info: new TextEncoder().encode("payload") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  assertSamlPostOwner(owner);
  const receipt = await crypto.subtle.deriveKey(
    { ...parameters, info: new TextEncoder().encode("delivery receipt") },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
  assertSamlPostOwner(owner);
  return { aes, receipt };
}
export async function samlPostMac(
  key: CryptoKey,
  text: string,
  owner: SamlPostOwner,
): Promise<string> {
  assertSamlPostOwner(owner);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(text),
  );
  assertSamlPostOwner(owner);
  return samlPostBytes(mac);
}
export async function checkSamlPostMac(
  key: CryptoKey,
  mac: string,
  text: string,
  owner: SamlPostOwner,
): Promise<boolean> {
  assertSamlPostOwner(owner);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    samlPostDecode(SamlNonceSchema.parse(mac)),
    new TextEncoder().encode(text),
  );
  assertSamlPostOwner(owner);
  return valid;
}
/** Every RPC port closes on response, cancellation, timeout, or synchronous send failure. */
export function samlPostRpc(
  worker: ServiceWorker,
  command: z.infer<typeof SamlPostCommandSchema>,
  owner: SamlPostOwner,
): Promise<SamlPostReply> {
  assertSamlPostOwner(owner);
  return new Promise((resolve, reject) => {
    const ports = new MessageChannel();
    const finish = (value: SamlPostReply | Error) => {
      clearTimeout(timer);
      owner.signal.removeEventListener("abort", cancelled);
      ports.port1.close();
      ports.port2.close();
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    const cancelled = () => finish(new Error("SAML transport cancelled"));
    const timer = setTimeout(
      () => finish(new Error("SAML worker response expired")),
      3000,
    );
    owner.signal.addEventListener("abort", cancelled, { once: true });
    ports.port1.onmessage = (event: MessageEvent<BoundaryValue>) => {
      try {
        assertSamlPostOwner(owner);
        finish(SamlPostReplySchema.parse(event.data));
      } catch {
        finish(new Error("Invalid SAML worker response"));
      }
    };
    try {
      worker.postMessage(SamlPostCommandSchema.parse(command), [ports.port2]);
    } catch {
      finish(new Error("SAML worker unavailable"));
    }
  });
}
/** Exact deployed scope and ACS path: a lookalike prefix never qualifies. */
export function samlPostLocation(scopeUrl: string, acsUrl: string): URL {
  const scope = new URL(scopeUrl);
  const acs = new URL(acsUrl);
  if (
    scope.origin !== location.origin ||
    !scope.pathname.endsWith("/") ||
    scope.search ||
    scope.hash ||
    scope.username ||
    scope.password ||
    acs.href !== new URL("auth/native-saml", scope).href ||
    !location.pathname.startsWith(scope.pathname)
  )
    throw new Error("SAML callback does not belong to this PWA scope");
  return scope;
}
export async function samlPostController(
  scopeUrl: string,
  acsUrl: string,
  owner: SamlPostOwner,
): Promise<ServiceWorker> {
  samlPostLocation(scopeUrl, acsUrl);
  assertSamlPostOwner(owner);
  const controlled = navigator.serviceWorker.controller;
  const registration = await navigator.serviceWorker.getRegistration(acsUrl);
  assertSamlPostOwner(owner);
  if (
    !controlled ||
    navigator.serviceWorker.controller !== controlled ||
    registration?.active !== controlled ||
    registration.scope !== scopeUrl
  )
    throw new Error(
      "Reload this PWA under its active service worker before SAML sign-in",
    );
  return controlled;
}
