/**
 * The one door a device identity key passes before it is ranked, adopted,
 * restored or published (ADR 0160 §5a).
 *
 * A record read from a body or a backup is JSON someone else wrote, so shape is
 * not trust. A record is *trusted* when it has the shape this build reads
 * (`readDeviceIdentityKeyRecord`, which also refuses a `createdAt` that is not
 * a plausible time), its key id is the RFC 7638 thumbprint of its public key,
 * and its private half belongs to that public key, proven by signing with one
 * and verifying with the other. Anything else is not a key: it never ranks,
 * never wins, never replaces a genuine key on either side, and is dropped
 * where a body would carry it on.
 *
 * One kind of record is neither trusted nor dropped: a newer build's, a
 * version this build does not know. It is left exactly as it is and nothing is
 * minted beside it.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { sha256Base64Url } from "@opensesame/sdk-browser";
import {
  DEVICE_KEY_MAX_PRIVATE_JWK_CHARS,
  type DeviceIdentityKeyRecord,
  type DeviceKeyTimeBounds,
  isFutureDeviceKeyRecord,
  readDeviceIdentityKeyRecord,
} from "@opensesame/vault-core";

const CHALLENGE = new TextEncoder().encode("opensesame device identity key");
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;

/** RFC 7638: SHA-256 over the required members, in lexicographic order. */
export function p256JwkThumbprint(
  jwk: Readonly<{ x: string; y: string }>,
): Promise<string> {
  return sha256Base64Url(
    JSON.stringify({ crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y }),
  );
}

/** Does `privateJwkJson` hold the private half of `publicJwk`? */
async function ownsPublic(record: DeviceIdentityKeyRecord): Promise<boolean> {
  if (record.privateJwkJson.length > DEVICE_KEY_MAX_PRIVATE_JWK_CHARS) {
    return false;
  }
  try {
    const parsed: BoundaryValue = JSON.parse(record.privateJwkJson);
    if (
      !isJsonObject(parsed) ||
      parsed.kty !== "EC" ||
      parsed.crv !== "P-256" ||
      !isString(parsed.d) ||
      parsed.x !== record.publicJwk.x ||
      parsed.y !== record.publicJwk.y
    ) {
      return false;
    }
    const priv = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: parsed.x, y: parsed.y, d: parsed.d },
      ECDSA,
      false,
      ["sign"],
    );
    const pub = await crypto.subtle.importKey(
      "jwk",
      { ...record.publicJwk },
      ECDSA,
      false,
      ["verify"],
    );
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      priv,
      CHALLENGE,
    );
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pub,
      signature,
      CHALLENGE,
    );
  } catch {
    return false;
  }
}

/** Is this shape-valid record genuine: its id its key's thumbprint, its private half its key's? */
export async function deviceKeyIsGenuine(
  record: DeviceIdentityKeyRecord,
): Promise<boolean> {
  return (
    record.keyId === (await p256JwkThumbprint(record.publicJwk)) &&
    (await ownsPublic(record))
  );
}

/**
 * The record, when `value` is a key this build can trust; otherwise null.
 * `bounds` fence `createdAt` (default: any time up to a day past now); the
 * tomb's own file, which this device wrote, is read with no upper bound so a
 * clock set back later cannot lock a vault out of its own principal. The
 * shape check runs first and bounds every field, so nothing unbounded or
 * non-canonical is hashed, parsed or imported.
 */
export async function trustedDeviceKey(
  value: BoundaryValue,
  bounds: Partial<DeviceKeyTimeBounds> = {},
): Promise<DeviceIdentityKeyRecord | null> {
  const record = readDeviceIdentityKeyRecord(
    value,
    bounds.now ?? Date.now(),
    bounds.notBefore ?? 1,
  );
  return record && (await deviceKeyIsGenuine(record)) ? record : null;
}

/**
 * What a body or a backup carries under `deviceIdentityKey`:
 * - `absent`: nothing, or `null`;
 * - `trusted`: a key this build trusts;
 * - `future`: a record of a version this build does not know, small and
 *   shaped as far as any version is (a key id and a public key), to be left
 *   alone;
 * - `poison`: anything else (a forged id, a private half that is not the
 *   public key's, a non-object, a time that cannot be real, a high version
 *   number on something that is not a key record), to be treated as absent
 *   and dropped from any body that would carry it on.
 */
export type CarriedKey =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "trusted"; record: DeviceIdentityKeyRecord }>
  | Readonly<{ kind: "future" }>
  | Readonly<{ kind: "poison" }>;

export async function vetCarriedKey(
  value: BoundaryValue,
  bounds: Partial<DeviceKeyTimeBounds> = {},
): Promise<CarriedKey> {
  if (value === undefined || value === null) return { kind: "absent" };
  if (isFutureDeviceKeyRecord(value)) return { kind: "future" };
  const record = await trustedDeviceKey(value, bounds);
  return record ? { kind: "trusted", record } : { kind: "poison" };
}

/**
 * The field a body may keep: the trusted or newer-version one as it is, and
 * `undefined` for nothing or poison. Ranking and merging start from this.
 */
export async function vettedField(
  field: BoundaryValue,
  bounds: Partial<DeviceKeyTimeBounds> = {},
): Promise<JsonObject | undefined> {
  const carried = await vetCarriedKey(field, bounds);
  return (carried.kind === "trusted" || carried.kind === "future") &&
    isJsonObject(field)
    ? field
    : undefined;
}
