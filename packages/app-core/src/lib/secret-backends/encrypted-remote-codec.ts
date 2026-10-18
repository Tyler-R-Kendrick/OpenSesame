import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { b64ToBytes, bytesToB64 } from "@opensesame/vault-core/bytes.js";
/** OpenSesame's encrypted object contract v1; names and values remain inside AEAD. */
import { gcmOpen, gcmSeal } from "@opensesame/vault-core/gcm.js";
import { z } from "zod";
import { secretBackendUrl } from "./http.js";
import {
  type SecretBackendConfiguration,
  SecretBackendError,
} from "./types.js";
export const REMOTE_FORMAT = "opensesame.encrypted-remote";
export const MAX_REMOTE_BYTES = 4 * 1024 * 1024;
const field = z.string().max(1024 * 1024);
const Item = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(256),
    kind: z.enum(["note", "login", "secret"]),
    notes: field,
    secret: field,
    username: z.string().max(4096).optional(),
    url: z.string().max(8192).optional(),
    fields: z
      .record(z.string().max(256), z.string().max(65536))
      .refine((value) => Object.keys(value).length <= 64)
      .optional(),
  })
  .strict();
const Store = z
  .object({
    version: z.literal(1),
    storeId: z.string().uuid(),
    revision: z.number().int().positive().safe(),
    items: z.array(Item).max(1024),
  })
  .strict()
  .refine(
    (store) =>
      new Set(store.items.map((item) => item.id)).size === store.items.length &&
      new Set(store.items.map((item) => item.name)).size === store.items.length,
  );
const Envelope = z
  .object({
    format: z.literal(REMOTE_FORMAT),
    version: z.literal(1),
    storeId: z.string().uuid(),
    revision: z.number().int().positive().safe(),
    nonce: z.string().length(16),
    ciphertext: z.string().min(24).max(MAX_REMOTE_BYTES),
  })
  .strict();
export type EncryptedRemoteStore = z.infer<typeof Store>;
export type EncryptedRemoteItem = z.infer<typeof Item>;
export type EncryptedRemoteIdentity = Readonly<{
  objectUrl: string;
  storeId: string;
}>;
export function remoteCodecError(): SecretBackendError {
  return new SecretBackendError(
    "response",
    "The encrypted store is invalid or does not match its key and configured identity.",
  );
}
function decodeBase64(value: string, size?: number): Uint8Array {
  if (value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw remoteCodecError();
  const bytes = b64ToBytes(value);
  if (
    bytesToB64(bytes) !== value ||
    (size !== undefined && bytes.length !== size)
  )
    throw remoteCodecError();
  return bytes;
}
export async function remoteEncryptionKey(encoded: string): Promise<CryptoKey> {
  const bytes = decodeBase64(encoded, 32);
  try {
    return await crypto.subtle.importKey(
      "raw",
      overlapCast(bytes),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    bytes.fill(0);
  }
}
function aad(identity: EncryptedRemoteIdentity, revision: number): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      REMOTE_FORMAT,
      1,
      identity.objectUrl,
      identity.storeId,
      revision,
    ]),
  );
}
export function remoteStore(value: BoundaryValue): EncryptedRemoteStore {
  const result = Store.safeParse(value);
  if (!result.success) throw remoteCodecError();
  return result.data;
}
export function remoteItem(value: BoundaryValue): EncryptedRemoteItem {
  const result = Item.safeParse(value);
  if (!result.success)
    throw new SecretBackendError(
      "configuration",
      "Enter a bounded note, login, or secret with a unique name.",
    );
  return result.data;
}
export async function sealRemoteStore(
  store: EncryptedRemoteStore,
  identity: EncryptedRemoteIdentity,
  key: CryptoKey,
): Promise<string> {
  const checked = remoteStore(store);
  if (checked.storeId !== identity.storeId) throw remoteCodecError();
  const plain = new TextEncoder().encode(JSON.stringify(checked));
  if (plain.length > 3 * 1024 * 1024 - 128) throw remoteCodecError();
  try {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await gcmSeal(
      key,
      plain,
      nonce,
      aad(identity, checked.revision),
    );
    const serialized = JSON.stringify({
      format: REMOTE_FORMAT,
      version: 1,
      storeId: identity.storeId,
      revision: checked.revision,
      nonce: bytesToB64(nonce),
      ciphertext: bytesToB64(ciphertext),
    });
    if (new TextEncoder().encode(serialized).length > MAX_REMOTE_BYTES)
      throw remoteCodecError();
    return serialized;
  } finally {
    plain.fill(0);
  }
}
export async function openRemoteStore(
  serialized: string,
  identity: EncryptedRemoteIdentity,
  key: CryptoKey,
): Promise<EncryptedRemoteStore> {
  let plain: Uint8Array | undefined;
  try {
    if (new TextEncoder().encode(serialized).length > MAX_REMOTE_BYTES)
      throw remoteCodecError();
    const envelope = Envelope.parse(JSON.parse(serialized));
    if (envelope.storeId !== identity.storeId) throw remoteCodecError();
    plain = await gcmOpen(
      key,
      decodeBase64(envelope.nonce, 12),
      decodeBase64(envelope.ciphertext),
      aad(identity, envelope.revision),
    );
    const store = remoteStore(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)),
    );
    if (
      store.storeId !== envelope.storeId ||
      store.revision !== envelope.revision
    )
      throw remoteCodecError();
    return store;
  } catch {
    throw remoteCodecError();
  } finally {
    plain?.fill(0);
  }
}

const Configuration = z
  .object({
    objectUrl: z
      .string()
      .url()
      .max(4096)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }),
    storeId: z.string().uuid(),
    encryptionKey: z.string().length(44),
    bearerToken: z
      .string()
      .min(1)
      .max(32768)
      .regex(/^[\x21-\x7E]+$/)
      .optional(),
  })
  .strict()
  .refine((value) => value.bearerToken !== value.encryptionKey);
/** Leaf contract. Later shared configuration activation supplies these explicit fields. */
export type EncryptedRemoteConfiguration = z.infer<typeof Configuration>;

export function remoteConfiguration(
  input: SecretBackendConfiguration | EncryptedRemoteConfiguration,
): EncryptedRemoteConfiguration {
  const result = Configuration.safeParse(input);
  if (!result.success)
    throw new SecretBackendError(
      "configuration",
      "Enter one HTTPS object URL, store identity, encryption key and a separate optional access token.",
    );
  secretBackendUrl(result.data.objectUrl);
  return { ...result.data, objectUrl: new URL(result.data.objectUrl).href };
}

export function remoteStrongEtag(header: string | null): string {
  const value = header ?? "";
  if (!/^"[\x21\x23-\x7E\x80-\xFF]{0,256}"$/.test(value))
    throw new SecretBackendError(
      "configuration",
      "This object endpoint must expose a strong ETag and honor conditional PUT requests.",
    );
  return value;
}
