import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { z } from "zod";
import type { BitwardenKdf } from "./bitwarden-native-kdf.js";
import { SecretBackendError } from "./types.js";

type JsonObject = { [key: string]: BoundaryValue };
export type BitwardenPasswordUnlock = {
  kdf: BitwardenKdf;
  salt: string;
  wrappedKey: string;
};
export type BitwardenNativeCredentials = {
  baseUrl: string;
  identityUrl: string;
  email: string;
  clientId: string;
  clientSecret: string;
  deviceIdentifier: string;
};
function wellFormed(value: string): boolean {
  return new TextDecoder().decode(new TextEncoder().encode(value)) === value;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function bitwardenProtocolError(): SecretBackendError {
  return new SecretBackendError(
    "response",
    "Invalid native Bitwarden account response.",
  );
}
function object(value: BoundaryValue | undefined): JsonObject {
  if (!value || !isJsonObject(value)) throw bitwardenProtocolError();
  return value;
}
/** One case boundary; contradictory camel/Pascal properties never win by order. */
function field(value: JsonObject, name: string): BoundaryValue | undefined {
  const upper = name.charAt(0).toUpperCase() + name.slice(1);
  const lowerValue = Object.hasOwn(value, name) ? value[name] : undefined;
  const upperValue = Object.hasOwn(value, upper) ? value[upper] : undefined;
  if (
    lowerValue !== undefined &&
    upperValue !== undefined &&
    JSON.stringify(lowerValue) !== JSON.stringify(upperValue)
  )
    throw bitwardenProtocolError();
  return lowerValue === undefined ? upperValue : lowerValue;
}
function text(value: BoundaryValue | undefined, maximum = 4096): string {
  const parsed = z.string().min(1).max(maximum).safeParse(value);
  if (!parsed.success || !wellFormed(parsed.data))
    throw bitwardenProtocolError();
  return parsed.data;
}
function integer(value: BoundaryValue | undefined, maximum: number): number {
  const parsed = z.number().int().positive().max(maximum).safeParse(value);
  if (!parsed.success) throw bitwardenProtocolError();
  return parsed.data;
}
function kdf(value: BoundaryValue | undefined, legacy = false): BitwardenKdf {
  const source = object(value);
  const kind = field(source, legacy ? "kdf" : "kdfType");
  const iterations = integer(
    field(source, legacy ? "kdfIterations" : "iterations"),
    2_000_000,
  );
  if (kind === 0) return { kdfType: 0, iterations };
  if (kind !== 1) throw bitwardenProtocolError();
  return {
    kdfType: 1,
    iterations,
    memoryMiB: integer(field(source, legacy ? "kdfMemory" : "memory"), 1024),
    parallelism: integer(
      field(source, legacy ? "kdfParallelism" : "parallelism"),
      16,
    ),
  };
}
export function bitwardenAccountIdentity(
  config: BitwardenNativeCredentials,
): string {
  if (
    !/^user\./.test(config.clientId) ||
    !UUID.test(config.clientId.slice(5)) ||
    !UUID.test(config.deviceIdentifier) ||
    !config.email.trim().includes("@") ||
    config.email.length > 4096 ||
    !wellFormed(config.email) ||
    !config.clientSecret.length ||
    config.clientSecret.length > 4096 ||
    !wellFormed(config.clientSecret)
  )
    throw new SecretBackendError(
      "configuration",
      "Enter a personal account email, user API credentials and device identifier.",
    );
  return config.clientId.slice(5).toLowerCase();
}
export function decodeBitwardenPrelogin(
  value: BoundaryValue,
  email: string,
): Omit<BitwardenPasswordUnlock, "wrappedKey"> {
  const source = object(value);
  const modern = field(source, "kdfSettings");
  const salt = field(source, "salt");
  return {
    kdf: modern === undefined ? kdf(source, true) : kdf(modern),
    salt:
      salt === null || salt === undefined
        ? email.trim().toLowerCase()
        : text(salt),
  };
}
type NativeToken = { token: string; expiresIn: number; raw: JsonObject };
export function decodeBitwardenToken(value: BoundaryValue): NativeToken {
  const raw = object(value);
  const token = text(raw.access_token, 16384);
  if (raw.token_type !== "Bearer" || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token))
    throw bitwardenProtocolError();
  if (raw.scope !== undefined) {
    const scopes = text(raw.scope).split(" ");
    if (!scopes.includes("api") || scopes.includes("api.organization"))
      throw bitwardenProtocolError();
  }
  return { token, expiresIn: integer(raw.expires_in, 86400), raw };
}
function wrapped(value: JsonObject): string {
  const encrypted = field(value, "masterKeyEncryptedUserKey");
  const replacement = field(value, "masterKeyWrappedUserKey");
  if (
    encrypted !== undefined &&
    replacement !== undefined &&
    encrypted !== replacement
  )
    throw bitwardenProtocolError();
  return text(replacement === undefined ? encrypted : replacement, 16384);
}
function modernUnlock(
  value: BoundaryValue | undefined,
): BitwardenPasswordUnlock | undefined {
  if (value === undefined || value === null) return undefined;
  const source = object(value);
  if (field(source, "hasMasterPassword") === false)
    throw bitwardenProtocolError();
  const unlock = field(source, "masterPasswordUnlock");
  if (unlock === undefined) return undefined;
  const data = object(unlock);
  return {
    salt: text(field(data, "salt")),
    kdf: kdf(field(data, "kdf")),
    wrappedKey: wrapped(data),
  };
}
type NativeSync = { ciphers: BoundaryValue[]; unlock: BitwardenPasswordUnlock };
export function decodeBitwardenSync(
  value: BoundaryValue,
  token: BoundaryValue,
  config: BitwardenNativeCredentials,
  prelogin: Omit<BitwardenPasswordUnlock, "wrappedKey">,
): NativeSync {
  const source = object(value);
  const identity = object(field(source, "profile"));
  const id = text(field(identity, "id"));
  const email = text(field(identity, "email"));
  if (
    id.toLowerCase() !== bitwardenAccountIdentity(config) ||
    email.trim().toLowerCase() !== config.email.trim().toLowerCase()
  )
    throw new SecretBackendError(
      "authentication",
      "The authenticated account does not match this connection.",
    );
  const ciphers = field(source, "ciphers");
  if (!Array.isArray(ciphers) || ciphers.length > 50000)
    throw bitwardenProtocolError();
  const tokenObject = object(token);
  const synced = modernUnlock(field(source, "userDecryption"));
  const issued = modernUnlock(field(tokenObject, "userDecryptionOptions"));
  if (synced && issued && JSON.stringify(synced) !== JSON.stringify(issued))
    throw bitwardenProtocolError();
  if (synced) return { ciphers, unlock: synced };
  if (issued) return { ciphers, unlock: issued };
  return { ciphers, unlock: legacyUnlock(identity, tokenObject, prelogin) };
}

function legacyUnlock(
  identity: JsonObject,
  tokenObject: JsonObject,
  prelogin: Omit<BitwardenPasswordUnlock, "wrappedKey">,
): BitwardenPasswordUnlock {
  const profileKey = field(identity, "key");
  const tokenKey = field(tokenObject, "key");
  if (
    profileKey !== undefined &&
    tokenKey !== undefined &&
    profileKey !== tokenKey
  )
    throw bitwardenProtocolError();
  const legacyKdf =
    field(tokenObject, "kdf") === undefined
      ? prelogin.kdf
      : kdf(tokenObject, true);
  return {
    kdf: legacyKdf,
    salt: prelogin.salt,
    wrappedKey: text(profileKey === undefined ? tokenKey : profileKey, 16384),
  };
}
