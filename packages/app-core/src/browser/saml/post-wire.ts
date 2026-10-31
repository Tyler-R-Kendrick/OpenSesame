/** Bounded transport messages; none of these messages establishes SAML authentication. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod/mini";
import en from "zod/v4/locales/en.js";
import {
  type SamlPostOwner,
  assertSamlPostOwner,
} from "./assertion-conditions.js";
export {
  type SamlPostOwner,
  assertSamlPostOwner,
} from "./assertion-conditions.js";

export const SAML_POST_BYTES = 262144;
// Match classic Zod's default locale without importing its schema-method
// runtime into each service worker. An explicitly configured locale wins.
if (!z.config().localeError) z.config(en());
export const SamlNonceSchema = z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/));
const point = z.string().check(z.regex(/^[A-Za-z0-9_-]{87}$/));
const client = z.string().check(z.minLength(1), z.maxLength(128));
const request = z.string().check(z.regex(/^_[A-Za-z0-9_.-]{1,255}$/));
export const SamlPostArmSchema = z.strictObject({
  kind: z.literal("SAML_ARM"),
  nonce: SamlNonceSchema,
  requestId: request,
  expiresAt: z.int().check(z.positive()),
  idpOrigin: z.url().check(z.maxLength(2048)),
  publicKey: point,
});
export const SamlPostRecordSchema = z.strictObject({
  nonce: SamlNonceSchema,
  requestId: request,
  expiresAt: z.int().check(z.positive()),
  acsUrl: z.url().check(z.maxLength(2048)),
  recordId: client,
  publicKey: point,
});
export type SamlPostRecord = z.infer<typeof SamlPostRecordSchema>;
export const SamlPostCommandSchema = z.union([
  SamlPostArmSchema,
  z.strictObject({ kind: z.literal("SAML_CANCEL"), nonce: SamlNonceSchema }),
  z.strictObject({ kind: z.literal("SAML_METADATA") }),
  z.strictObject({
    kind: z.enum(["SAML_CLAIM", "SAML_CONSUME"]),
    nonce: SamlNonceSchema,
    recordId: client,
  }),
]);
export const SamlPostReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(false),
    reason: z.enum(["missing", "denied", "capacity", "malformed"]),
  }),
  z.strictObject({
    ok: z.literal(true),
    record: z.optional(SamlPostRecordSchema),
    response: z.optional(z.string().check(z.maxLength(SAML_POST_BYTES * 2))),
  }),
]);
export type SamlPostReply = z.infer<typeof SamlPostReplySchema>;
const binding = { nonce: SamlNonceSchema, recordId: client };
export const SamlPostChannelSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("hello"), ...binding, publicKey: point }),
  z.strictObject({
    kind: z.literal("ready"),
    ...binding,
    mac: SamlNonceSchema,
  }),
  z.strictObject({
    kind: z.literal("payload"),
    ...binding,
    publicKey: point,
    iv: z.string().check(z.regex(/^[A-Za-z0-9_-]{16}$/)),
    ciphertext: z
      .string()
      .check(z.minLength(22), z.maxLength(524288), z.regex(/^[A-Za-z0-9_-]+$/)),
  }),
  z.strictObject({
    kind: z.literal("received"),
    ...binding,
    mac: SamlNonceSchema,
  }),
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
