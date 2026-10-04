/**
 * The device identity key as the sealed body carries it (ADR 0160 §5).
 *
 * A vault's principal is the thumbprint of a P-256 key. The key is a tomb file
 * on the device that minted it (`config/device-identity-key`), and a copy rides
 * in the sealed body so it travels with everything that carries the vault: an
 * offline backup, a sealed export, a tailnet drive, a restore. The body is
 * sealed under the vault key, so only someone who can open the vault gets it.
 *
 * Two devices that each minted a key before their first sync hold different
 * ones. The merge picks one deterministically (the older `createdAt`, then the
 * smaller key id), so either argument order converges and so do all devices.
 * A record this build cannot read — a newer version, a shape it does not know —
 * is never replaced by one it can: a newer build may own it. The caller vets
 * both sides first (a forged or null record is dropped, not kept): this module
 * ranks, it does not trust.
 *
 * Leaf module: no platform, no storage, no hashing. Whether a record's key id
 * is its public key's thumbprint is the caller's check (it needs SHA-256).
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";

/** The tomb path the working copy lives at, and the name every lister prints. */
export const DEVICE_IDENTITY_KEY_PATH = "config/device-identity-key";

/** The base64url alphabet, in value order, so a character's index is its sextet. */
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * 32 bytes in base64url: 43 characters, 258 bits, the last two of them padding.
 * Only the form an encoder writes is read: a last character whose padding bits
 * are not zero names the same bytes as another string, and WebCrypto and a
 * hash would each accept both, so one key would have many ids and many
 * principals. Checked before anything is hashed or parsed.
 */
export function isCanonicalCoordinate(value: BoundaryValue): value is string {
  return (
    isString(value) &&
    value.length === 43 &&
    [...value].every((char) => ALPHABET.includes(char)) &&
    ALPHABET.indexOf(value.charAt(42)) % 4 === 0
  );
}

/** The longest private JWK a record may hold; a real one is about 250 characters. */
export const DEVICE_KEY_MAX_PRIVATE_JWK_CHARS = 4096;

/** The longest a record of a version this build does not read may be, as JSON. */
export const DEVICE_KEY_MAX_FUTURE_CHARS = 8192;

/**
 * How far past this device's clock a record's `createdAt` may sit. A key
 * minted on a device whose clock runs ahead is still read; one dated beyond
 * a day is not a key any honest device made, and a ranking by age must not let
 * a forged date decide it. Both ends are read as untrusted, never as old.
 */
export const DEVICE_KEY_CLOCK_MARGIN_MS = 24 * 60 * 60 * 1000;

/**
 * The window a key's `createdAt` must sit in: `notBefore` (a vault's own key
 * is minted after the vault is, give or take a clock) to `now`, with the
 * clock margin allowed past `now` when a record is read.
 */
export type DeviceKeyTimeBounds = Readonly<{ now: number; notBefore: number }>;

/**
 * The window for a vault whose header says it was created at `createdAt`
 * (an ISO time): no key of its own predates it by more than the margin.
 */
export function deviceKeyTimeBounds(
  createdAt: string | undefined,
  now: number = Date.now(),
): DeviceKeyTimeBounds {
  const born = createdAt === undefined ? Number.NaN : Date.parse(createdAt);
  const floor = Number.isFinite(born) ? born - DEVICE_KEY_CLOCK_MARGIN_MS : 1;
  return { now, notBefore: Math.min(Math.max(1, Math.floor(floor)), now) };
}

/**
 * `record` with `createdAt` brought inside the window: never later than `now`
 * (a clock that ran ahead, or a file written by one) and never before
 * `notBefore`. The key is the same key; only the date it ranks by moves.
 */
export function clampDeviceKeyTime(
  record: DeviceIdentityKeyRecord,
  bounds: DeviceKeyTimeBounds,
): DeviceIdentityKeyRecord {
  const createdAt = Math.min(
    Math.max(record.createdAt, bounds.notBefore),
    bounds.now,
  );
  return createdAt === record.createdAt ? record : { ...record, createdAt };
}

export type DeviceIdentityKeyRecord = Readonly<{
  version: 1;
  /** The RFC 7638 thumbprint of `publicJwk`; the principal is `prn_` + this. */
  keyId: string;
  publicJwk: Readonly<{ kty: "EC"; crv: "P-256"; x: string; y: string }>;
  /** The private JWK, serialized. Confidential: the body is sealed. */
  privateJwkJson: string;
  createdAt: number;
}>;

/**
 * A record this build reads, or null: unknown version, wrong shape, bad id, or
 * a `createdAt` that is not a positive time no later than a day past `now`.
 * Shape only: whether the key id is the public key's thumbprint and the
 * private half belongs to it takes SHA-256 and a signature, which the app
 * core checks (`device-identity-trust.ts`) before any record is ranked.
 */
export function readDeviceIdentityKeyRecord(
  value: BoundaryValue,
  now: number = Date.now(),
  notBefore = 1,
): DeviceIdentityKeyRecord | null {
  if (!isJsonObject(value) || value.version !== 1) return null;
  const pub = value.publicJwk;
  if (
    !isCanonicalCoordinate(value.keyId) ||
    !isString(value.privateJwkJson) ||
    value.privateJwkJson.length > DEVICE_KEY_MAX_PRIVATE_JWK_CHARS ||
    !plausibleTime(value.createdAt, now, notBefore) ||
    !isP256Public(pub)
  ) {
    return null;
  }
  return {
    version: 1,
    keyId: value.keyId,
    publicJwk: { kty: "EC", crv: "P-256", x: pub.x, y: pub.y },
    privateJwkJson: value.privateJwkJson,
    createdAt: value.createdAt,
  };
}

/** A whole time from `notBefore` to a day past `now`. */
function plausibleTime(
  value: BoundaryValue,
  now: number,
  notBefore: number,
): value is number {
  return (
    isNumber(value) &&
    Number.isSafeInteger(value) &&
    value >= Math.max(1, notBefore) &&
    value <= now + DEVICE_KEY_CLOCK_MARGIN_MS
  );
}

function isP256Public(
  value: BoundaryValue,
): value is JsonObject & { x: string; y: string } {
  return (
    isJsonObject(value) &&
    value.kty === "EC" &&
    value.crv === "P-256" &&
    isCanonicalCoordinate(value.x) &&
    isCanonicalCoordinate(value.y)
  );
}

/**
 * A record of a version this build does not read, shaped as far as any
 * version is: a whole version above 1, a key id and a public JWK, and small.
 * Such a record is a newer build's and is left alone; anything else that
 * merely claims a high version is not, and must not freeze carrying.
 */
export function isFutureDeviceKeyRecord(
  value: BoundaryValue,
): value is JsonObject {
  return (
    isJsonObject(value) &&
    isNumber(value.version) &&
    Number.isSafeInteger(value.version) &&
    value.version > 1 &&
    isString(value.keyId) &&
    value.keyId.length <= 128 &&
    isJsonObject(value.publicJwk) &&
    JSON.stringify(value).length <= DEVICE_KEY_MAX_FUTURE_CHARS
  );
}

/** The record as the body stores it. */
export function deviceKeyField(record: DeviceIdentityKeyRecord): JsonObject {
  return {
    version: 1,
    keyId: record.keyId,
    publicJwk: { ...record.publicJwk },
    privateJwkJson: record.privateJwkJson,
    createdAt: record.createdAt,
  };
}

/**
 * Which of two keys is the vault's: the older `createdAt`, then the smaller
 * key id (plain code-unit order, the same on every device). Total and
 * antisymmetric, so every device that sees both reaches the same answer.
 */
export function winningDeviceKey(
  left: DeviceIdentityKeyRecord,
  right: DeviceIdentityKeyRecord,
): DeviceIdentityKeyRecord {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? left : right;
  }
  return left.keyId <= right.keyId ? left : right;
}

/**
 * The key two bodies agree on. An absent side yields the other; two readable
 * records yield `winningDeviceKey`'s; a record this build cannot read is kept
 * over any it can, so a newer build's key is never overwritten by an older
 * one. Commutative, so a drive can be merged in either order.
 */
export function mergeDeviceKeyFields(
  leftField: BoundaryValue,
  rightField: BoundaryValue,
): JsonObject | undefined {
  // A body is JSON from anywhere: `null`, a string or a number is no record.
  const left = isJsonObject(leftField) ? leftField : undefined;
  const right = isJsonObject(rightField) ? rightField : undefined;
  if (left === undefined) return right;
  if (right === undefined) return left;
  const a = readDeviceIdentityKeyRecord(left);
  const b = readDeviceIdentityKeyRecord(right);
  if (a && b && a.keyId !== b.keyId) {
    return winningDeviceKey(a, b) === a ? left : right;
  }
  // The same key twice, or neither readable: any fixed order, so it commutes.
  if (a && !b) return right;
  if (b && !a) return left;
  return JSON.stringify(left) <= JSON.stringify(right) ? left : right;
}
