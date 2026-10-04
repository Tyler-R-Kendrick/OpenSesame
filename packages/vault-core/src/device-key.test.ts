/**
 * The device identity key as the body carries it (ADR 0160 §5): what is read,
 * which of two keys is the vault's, and that every merge order agrees.
 */
import type { JsonObject } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  DEVICE_IDENTITY_KEY_PATH,
  DEVICE_KEY_CLOCK_MARGIN_MS,
  type DeviceIdentityKeyRecord,
  deviceKeyField,
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
    publicJwk: { kty: "EC", crv: "P-256", x: `x-${seed}`, y: `y-${seed}` },
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
