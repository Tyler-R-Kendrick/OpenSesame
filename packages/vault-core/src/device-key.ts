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
 * is never replaced by one it can: a newer build may own it.
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

const THUMBPRINT = /^[A-Za-z0-9_-]{43}$/;

export type DeviceIdentityKeyRecord = Readonly<{
  version: 1;
  /** The RFC 7638 thumbprint of `publicJwk`; the principal is `prn_` + this. */
  keyId: string;
  publicJwk: Readonly<{ kty: "EC"; crv: "P-256"; x: string; y: string }>;
  /** The private JWK, serialized. Confidential: the body is sealed. */
  privateJwkJson: string;
  createdAt: number;
}>;

/** A record this build reads, or null: unknown version, wrong shape, bad id. */
export function readDeviceIdentityKeyRecord(
  value: BoundaryValue,
): DeviceIdentityKeyRecord | null {
  if (!isJsonObject(value) || value.version !== 1) return null;
  const pub = value.publicJwk;
  if (
    !isString(value.keyId) ||
    !THUMBPRINT.test(value.keyId) ||
    !isString(value.privateJwkJson) ||
    !isNumber(value.createdAt) ||
    !Number.isSafeInteger(value.createdAt) ||
    !isJsonObject(pub) ||
    pub.kty !== "EC" ||
    pub.crv !== "P-256" ||
    !isString(pub.x) ||
    !isString(pub.y)
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
  left: JsonObject | undefined,
  right: JsonObject | undefined,
): JsonObject | undefined {
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
