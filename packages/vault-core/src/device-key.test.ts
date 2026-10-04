/**
 * The device identity key as the body carries it (ADR 0160 §5): what is read,
 * which of two keys is the vault's, and that every merge order agrees.
 */
import type { JsonObject } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  DEVICE_IDENTITY_KEY_PATH,
  DEVICE_KEY_CLOCK_MARGIN_MS,
  DEVICE_KEY_MAX_FUTURE_CHARS,
  DEVICE_KEY_MAX_PRIVATE_JWK_CHARS,
  type DeviceIdentityKeyRecord,
  clampDeviceKeyTime,
  deviceKeyField,
  deviceKeyTimeBounds,
  isCanonicalCoordinate,
  isFutureDeviceKeyRecord,
  mergeDeviceKeyFields,
  readDeviceIdentityKeyRecord,
  winningDeviceKey,
} from "./device-key.js";
import { mergeVaultBodies, sameVaultContent } from "./merge.js";
import { emptyBody } from "./model.js";

/** A 43-character id, as a thumbprint is. */
function keyId(seed: string): string {
  return seed.padEnd(43, "A").slice(0, 43);
}

function record(seed: string, createdAt: number): DeviceIdentityKeyRecord {
  return {
    version: 1,
    keyId: keyId(seed),
    publicJwk: {
      kty: "EC",
      crv: "P-256",
      x: keyId(`x${seed}`),
      y: keyId(`y${seed}`),
    },
    privateJwkJson: `{"d":"d-${seed}"}`,
    createdAt,
  };
}

const older = record("bbb", 1_000);
const newer = record("aaa", 2_000);

/** A body a newer build wrote: a version this build does not read. */
const future: JsonObject = {
  version: 2,
  keyId: keyId("zzz"),
  publicJwk: { kty: "EC", crv: "P-256", x: keyId("xzzz"), y: keyId("yzzz") },
  sealed: "opaque",
};

describe("reading a carried key", () => {
  it("round-trips a record through the body field", () => {
    expect(readDeviceIdentityKeyRecord(deviceKeyField(older))).toEqual(older);
  });

  it.each([
    ["an unknown version", { ...deviceKeyField(older), version: 2 }],
    ["a short key id", { ...deviceKeyField(older), keyId: "short" }],
    [
      "a key id with a slash",
      { ...deviceKeyField(older), keyId: `${"A".repeat(42)}/` },
    ],
    ["a missing private half", { ...deviceKeyField(older), privateJwkJson: 7 }],
    ["a fractional time", { ...deviceKeyField(older), createdAt: 1.5 }],
    [
      "another curve",
      {
        ...deviceKeyField(older),
        publicJwk: { kty: "EC", crv: "P-384", x: "x", y: "y" },
      },
    ],
  ])("refuses %s", (_name, field) => {
    expect(readDeviceIdentityKeyRecord(field)).toBeNull();
  });

  it("names the path every lister prints", () => {
    expect(DEVICE_IDENTITY_KEY_PATH).toBe("config/device-identity-key");
  });
});

describe("which key is the vault's", () => {
  it("is the older one, whichever way round they are asked", () => {
    expect(winningDeviceKey(older, newer)).toBe(older);
    expect(winningDeviceKey(newer, older)).toBe(older);
  });

  it("breaks a tie on the smaller key id, the same on every device", () => {
    const a = record("aaa", 5);
    const b = record("bbb", 5);
    expect(winningDeviceKey(a, b)).toBe(a);
    expect(winningDeviceKey(b, a)).toBe(a);
  });

  it("is decided by time before id: a smaller id does not beat an older key", () => {
    const smallerIdButNewer = record("aaa", 9);
    const largerIdButOlder = record("zzz", 1);
    expect(winningDeviceKey(smallerIdButNewer, largerIdButOlder)).toBe(
      largerIdButOlder,
    );
  });
});

describe("merging two bodies' keys", () => {
  const olderField = deviceKeyField(older);
  const newerField = deviceKeyField(newer);

  it("yields the other side when one has none", () => {
    expect(mergeDeviceKeyFields(undefined, olderField)).toBe(olderField);
    expect(mergeDeviceKeyFields(olderField, undefined)).toBe(olderField);
    expect(mergeDeviceKeyFields(undefined, undefined)).toBeUndefined();
  });

  it("keeps the winner, in either order", () => {
    expect(mergeDeviceKeyFields(olderField, newerField)).toEqual(olderField);
    expect(mergeDeviceKeyFields(newerField, olderField)).toEqual(olderField);
  });

  it("never replaces a record it cannot read with one it can", () => {
    expect(mergeDeviceKeyFields(olderField, future)).toBe(future);
    expect(mergeDeviceKeyFields(future, olderField)).toBe(future);
  });

  it("commutes over every pairing, readable or not, equal or not", () => {
    const fields: (JsonObject | undefined)[] = [
      undefined,
      olderField,
      newerField,
      deviceKeyField(record("bbb", 9_999)),
      future,
      { version: 3 },
    ];
    for (const left of fields) {
      for (const right of fields) {
        expect(mergeDeviceKeyFields(left, right)).toEqual(
          mergeDeviceKeyFields(right, left),
        );
      }
    }
  });

  it("converges whatever order three devices' keys meet in", () => {
    const fields = [
      olderField,
      newerField,
      deviceKeyField(record("ccc", 1_500)),
    ];
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const results = orders.map((order) =>
      order
        .map((at) => fields[at])
        .reduce<JsonObject | undefined>(
          (held, next) => mergeDeviceKeyFields(held, next),
          undefined,
        ),
    );
    for (const result of results) expect(result).toEqual(olderField);
  });
});

describe("a vault merge", () => {
  const withKey = (record_: DeviceIdentityKeyRecord) => ({
    ...emptyBody(),
    deviceIdentityKey: deviceKeyField(record_),
  });

  it("carries the key through, from either side", () => {
    expect(
      mergeVaultBodies(withKey(older), emptyBody()).deviceIdentityKey,
    ).toEqual(deviceKeyField(older));
    expect(
      mergeVaultBodies(emptyBody(), withKey(older)).deviceIdentityKey,
    ).toEqual(deviceKeyField(older));
  });

  it("leaves no field behind when neither side held a key", () => {
    expect(
      "deviceIdentityKey" in mergeVaultBodies(emptyBody(), emptyBody()),
    ).toBe(false);
  });

  it("makes two devices that each minted a key agree on one", () => {
    const left = mergeVaultBodies(withKey(older), withKey(newer));
    const right = mergeVaultBodies(withKey(newer), withKey(older));
    expect(left.deviceIdentityKey).toEqual(deviceKeyField(older));
    expect(sameVaultContent(left, right)).toBe(true);
  });

  it("counts a different key as different content, so a drive is replaced", () => {
    expect(sameVaultContent(withKey(older), withKey(newer))).toBe(false);
    expect(sameVaultContent(withKey(older), emptyBody())).toBe(false);
    expect(sameVaultContent(withKey(older), withKey(older))).toBe(true);
  });
});

describe("a key's time must be one an honest device could have written", () => {
  const now = 1_790_000_000_000;
  const at = (createdAt: number) =>
    readDeviceIdentityKeyRecord({ ...deviceKeyField(older), createdAt }, now);

  it("refuses the epoch, a time before it, and a time past the clock margin", () => {
    expect(at(0)).toBeNull();
    expect(at(-1)).toBeNull();
    expect(at(now + DEVICE_KEY_CLOCK_MARGIN_MS + 1)).toBeNull();
  });

  it("reads a time up to the margin ahead of this device's clock, and any time before it", () => {
    expect(at(1)?.createdAt).toBe(1);
    expect(at(now)?.createdAt).toBe(now);
    expect(at(now + DEVICE_KEY_CLOCK_MARGIN_MS)?.createdAt).toBe(
      now + DEVICE_KEY_CLOCK_MARGIN_MS,
    );
  });

  it("states its margin: a day", () => {
    expect(DEVICE_KEY_CLOCK_MARGIN_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("a body's field that is not an object is no record", () => {
  const field = deviceKeyField(older);

  it.each([null, "text", 7, true, []])(
    "merging %s with a key keeps the key, from either side",
    (odd) => {
      // A body is JSON from anywhere: a merge takes it as it comes.
      expect(mergeDeviceKeyFields(odd, field)).toBe(field);
      expect(mergeDeviceKeyFields(field, odd)).toBe(field);
      expect(mergeDeviceKeyFields(odd, odd)).toBeUndefined();
    },
  );
});

/** `value` with the last character's padding bits set: the same bytes, another string. */
function withPaddingBits(value: string): string {
  return `${value.slice(0, 42)}B`;
}

describe("a coordinate is read only in the form an encoder writes", () => {
  it("accepts 43 base64url characters whose padding bits are zero", () => {
    expect(isCanonicalCoordinate("A".repeat(43))).toBe(true);
    expect(isCanonicalCoordinate(`${"_-".repeat(21)}Q`)).toBe(true);
  });

  it.each([
    ["a last character with padding bits set", withPaddingBits("A".repeat(43))],
    ["one character short", "A".repeat(42)],
    ["one character long", "A".repeat(44)],
    ["a padded string", `${"A".repeat(43)}=`],
    ["a character outside the alphabet", `${"A".repeat(42)}+`],
    ["an empty string", ""],
  ])("refuses %s", (_name, value) => {
    expect(isCanonicalCoordinate(value)).toBe(false);
  });

  it("refuses a record whose x, y or key id is another spelling of the same bytes", () => {
    const base = deviceKeyField(older);
    const pub = { kty: "EC", crv: "P-256" };
    for (const field of [
      { ...base, keyId: withPaddingBits(older.keyId) },
      {
        ...base,
        publicJwk: {
          ...pub,
          x: withPaddingBits(older.publicJwk.x),
          y: older.publicJwk.y,
        },
      },
      {
        ...base,
        publicJwk: {
          ...pub,
          x: older.publicJwk.x,
          y: withPaddingBits(older.publicJwk.y),
        },
      },
    ]) {
      expect(readDeviceIdentityKeyRecord(field)).toBeNull();
    }
    expect(readDeviceIdentityKeyRecord(base)).toEqual(older);
  });

  it("refuses a private half past the bound, before anything parses it", () => {
    const privateJwkJson = "x".repeat(DEVICE_KEY_MAX_PRIVATE_JWK_CHARS + 1);
    expect(
      readDeviceIdentityKeyRecord({ ...deviceKeyField(older), privateJwkJson }),
    ).toBeNull();
    const atBound = "x".repeat(DEVICE_KEY_MAX_PRIVATE_JWK_CHARS);
    expect(
      readDeviceIdentityKeyRecord({
        ...deviceKeyField(older),
        privateJwkJson: atBound,
      }),
    ).not.toBeNull();
  });
});

describe("a record of a version this build does not read", () => {
  it("is honoured when it names a key id and a public key and is small", () => {
    expect(isFutureDeviceKeyRecord(future)).toBe(true);
  });

  it.each([
    ["no key id", { version: 2, publicJwk: {} }],
    ["no public key", { version: 2, keyId: "k" }],
    ["a key id that is not text", { version: 2, keyId: 7, publicJwk: {} }],
    ["a fractional version", { version: 2.5, keyId: "k", publicJwk: {} }],
    ["an unsafe version", { version: 2 ** 60, keyId: "k", publicJwk: {} }],
    ["version 1", { version: 1, keyId: "k", publicJwk: {} }],
    [
      "a size past the bound",
      {
        version: 2,
        keyId: "k",
        publicJwk: {},
        blob: "x".repeat(DEVICE_KEY_MAX_FUTURE_CHARS),
      },
    ],
    [
      "a key id past the bound",
      { version: 2, keyId: "k".repeat(129), publicJwk: {} },
    ],
  ])("is not honoured with %s", (_name, value) => {
    expect(isFutureDeviceKeyRecord(value)).toBe(false);
  });
});

describe("the window a vault's own key is dated in", () => {
  const now = 1_790_000_000_000;
  const born = "2026-03-01T00:00:00.000Z";
  const floor = Date.parse(born) - DEVICE_KEY_CLOCK_MARGIN_MS;

  it("starts a margin before the vault was made and ends now", () => {
    expect(deviceKeyTimeBounds(born, now)).toEqual({ now, notBefore: floor });
  });

  it("falls back to any time when the header names none or a bad one", () => {
    expect(deviceKeyTimeBounds(undefined, now).notBefore).toBe(1);
    expect(deviceKeyTimeBounds("not a date", now).notBefore).toBe(1);
  });

  it("refuses a key dated before the window when it is read with the floor", () => {
    const at = (createdAt: number) =>
      readDeviceIdentityKeyRecord(
        { ...deviceKeyField(older), createdAt },
        now,
        floor,
      );
    expect(at(floor - 1)).toBeNull();
    expect(at(floor)?.createdAt).toBe(floor);
  });

  it("moves a key's date into the window without changing the key", () => {
    const bounds = deviceKeyTimeBounds(born, now);
    const future_ = {
      ...older,
      createdAt: now + 5 * DEVICE_KEY_CLOCK_MARGIN_MS,
    };
    const past = { ...older, createdAt: 3 };
    expect(clampDeviceKeyTime(future_, bounds)).toEqual({
      ...older,
      createdAt: now,
    });
    expect(clampDeviceKeyTime(past, bounds)).toEqual({
      ...older,
      createdAt: floor,
    });
    const inside = { ...older, createdAt: now - 10 };
    expect(clampDeviceKeyTime(inside, bounds)).toBe(inside);
  });
});
