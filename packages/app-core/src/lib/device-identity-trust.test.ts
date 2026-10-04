/**
 * The one door a device identity key passes before it is ranked, adopted,
 * restored or published (ADR 0160 §5a): shape, a plausible time, an id that is
 * the key's thumbprint, and a private half that is the public key's.
 */

/** @vitest-environment jsdom */
import type { JsonObject } from "@opensesame/os-domain";
import {
  DEVICE_KEY_CLOCK_MARGIN_MS,
  type DeviceIdentityKeyRecord,
  deviceKeyField,
} from "@opensesame/vault-core";
import { describe, expect, it, vi } from "vitest";
import { genuineRecord } from "./__tests__/device-identity-records.js";
import {
  deviceKeyIsGenuine,
  p256JwkThumbprint,
  trustedDeviceKey,
  vetCarriedKey,
  vettedField,
} from "./device-identity-trust.js";

const NOW = Date.now();

/** A newer build's record: a version this build does not read, but shaped like a key. */
const NEWER: JsonObject = {
  version: 2,
  keyId: "k".repeat(43),
  publicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  from: "newer",
};

/** The same bytes as `value`, spelled with the last character's padding bits set. */
function otherSpelling(value: string): string {
  return `${value.slice(0, 42)}B`;
}

/**
 * A key whose x (or y) is another spelling of a genuine coordinate, with its
 * key id recomputed to match and its private JWK naming the same spelling.
 * WebCrypto ignores the padding bits, so the signature round trip passes: only
 * the canonical-form check tells it from a real key, and it would otherwise be
 * a second principal for the same key pair.
 */
async function respelled(
  coordinate: "x" | "y",
): Promise<DeviceIdentityKeyRecord> {
  const real = await genuineRecord(NOW - 1000);
  const publicJwk = {
    ...real.publicJwk,
    [coordinate]: otherSpelling(real.publicJwk[coordinate]),
  };
  const priv = JSON.parse(real.privateJwkJson);
  return {
    ...real,
    keyId: await p256JwkThumbprint(publicJwk),
    publicJwk,
    privateJwkJson: JSON.stringify({ ...priv, ...publicJwk }),
  };
}

/** A different record's private half under this record's public key and id. */
async function withForeignPrivateHalf(): Promise<DeviceIdentityKeyRecord> {
  const mine = await genuineRecord(NOW - 1000);
  const other = await genuineRecord(NOW - 1000);
  return { ...mine, privateJwkJson: other.privateJwkJson };
}

describe("a trusted key", () => {
  it("is a record whose id is its thumbprint and whose private half is its public key's", async () => {
    const record = await genuineRecord(NOW - 1000);
    expect(await deviceKeyIsGenuine(record)).toBe(true);
    expect(await trustedDeviceKey(deviceKeyField(record))).toEqual(record);
  });

  it("is not a record with another key's id, however low its time", async () => {
    const record = await genuineRecord(NOW - 1000);
    const fake = { ...record, keyId: "F".repeat(43), createdAt: 1 };
    expect(await deviceKeyIsGenuine(fake)).toBe(false);
    expect(await trustedDeviceKey(deviceKeyField(fake))).toBeNull();
  });

  it("is not a record whose private half belongs to another key", async () => {
    const forged = await withForeignPrivateHalf();
    // Shape and thumbprint both pass: only the signature round trip tells.
    expect(forged.keyId).toBe(await p256JwkThumbprint(forged.publicJwk));
    expect(await deviceKeyIsGenuine(forged)).toBe(false);
  });

  it("is not a record whose private half is garbage, oversized or names other coordinates", async () => {
    const record = await genuineRecord(NOW - 1000);
    const priv = JSON.parse(record.privateJwkJson);
    for (const privateJwkJson of [
      "not json",
      "null",
      JSON.stringify({ ...priv, x: "other" }),
      JSON.stringify({ ...priv, d: 7 }),
      JSON.stringify({ ...priv, d: "AAAA" }),
      JSON.stringify({ ...priv, pad: "x".repeat(5000) }),
    ]) {
      expect(await deviceKeyIsGenuine({ ...record, privateJwkJson })).toBe(
        false,
      );
    }
  });

  it("is not a record dated before the epoch or past the clock margin", async () => {
    const record = await genuineRecord(NOW - 1000);
    for (const createdAt of [
      0,
      -5,
      NOW + DEVICE_KEY_CLOCK_MARGIN_MS + 60_000,
    ]) {
      expect(
        await trustedDeviceKey(deviceKeyField({ ...record, createdAt })),
      ).toBeNull();
    }
    // A device whose clock runs a little ahead is still read.
    const slightly = { ...record, createdAt: NOW + 60 * 60 * 1000 };
    expect(await trustedDeviceKey(deviceKeyField(slightly))).not.toBeNull();
  });

  it.each(["x", "y"] as const)(
    "is not a key whose %s is another spelling of the same bytes, key id and all",
    async (coordinate) => {
      const probe = await respelled(coordinate);
      // Everything else about it is consistent: the id is its thumbprint. A
      // browser's WebCrypto also reads the respelled JWK, so the shape check
      // has to be what refuses it, before anything is imported.
      expect(probe.keyId).toBe(await p256JwkThumbprint(probe.publicJwk));
      const imported = vi.spyOn(crypto.subtle, "importKey");
      expect(await trustedDeviceKey(deviceKeyField(probe))).toBeNull();
      expect(imported).not.toHaveBeenCalled();
      imported.mockRestore();
      expect(await vetCarriedKey(deviceKeyField(probe))).toEqual({
        kind: "poison",
      });
    },
  );

  it("is not a record with a field past its bound, and nothing past it is hashed", async () => {
    const record = await genuineRecord(NOW - 1000);
    const huge = "A".repeat(2_000_000);
    for (const field of [
      { ...deviceKeyField(record), keyId: huge },
      {
        ...deviceKeyField(record),
        publicJwk: { ...record.publicJwk, x: huge },
      },
      {
        ...deviceKeyField(record),
        publicJwk: { ...record.publicJwk, y: huge },
      },
      { ...deviceKeyField(record), privateJwkJson: huge },
    ]) {
      expect(await trustedDeviceKey(field)).toBeNull();
    }
  });

  it("is not a record dated before the vault's window, and is one inside it", async () => {
    const record = await genuineRecord(NOW - 1000);
    const bounds = { now: NOW, notBefore: NOW - 5000 };
    expect(
      await trustedDeviceKey(
        deviceKeyField({ ...record, createdAt: NOW - 5001 }),
        bounds,
      ),
    ).toBeNull();
    expect(
      await trustedDeviceKey(
        deviceKeyField({ ...record, createdAt: NOW - 5000 }),
        bounds,
      ),
    ).not.toBeNull();
  });

  it.each([null, "a string", 7, true, ["a"], undefined])(
    "is never %s",
    async (value) => {
      expect(await trustedDeviceKey(value)).toBeNull();
    },
  );
});

describe("what a body or backup carries", () => {
  it("reads nothing and null as absent", async () => {
    expect(await vetCarriedKey(undefined)).toEqual({ kind: "absent" });
    expect(await vetCarriedKey(null)).toEqual({ kind: "absent" });
  });

  it("reads a newer version as future, to be left alone", async () => {
    expect(await vetCarriedKey(NEWER)).toEqual({ kind: "future" });
  });

  it.each([
    ["a bare version number", { version: 2 }],
    ["a high version with no public key", { version: 9, keyId: "k" }],
    ["a high version with no key id", { version: 9, publicJwk: {} }],
    ["an enormous high version", { ...NEWER, version: 2 ** 60 }],
    ["a high version past the size bound", { ...NEWER, pad: "x".repeat(9000) }],
  ])("reads %s as poison, not as a newer build's key", async (_name, value) => {
    expect(await vetCarriedKey(value)).toEqual({ kind: "poison" });
  });

  it("reads a forged, malformed or non-object value as poison", async () => {
    const record = await genuineRecord(NOW - 1000);
    for (const value of [
      deviceKeyField({ ...record, keyId: "F".repeat(43) }),
      deviceKeyField(await withForeignPrivateHalf()),
      { version: 1 },
      "text",
      42,
      [],
    ]) {
      expect(await vetCarriedKey(value)).toEqual({ kind: "poison" });
    }
  });

  it("keeps a trusted or future field as it is and drops the rest", async () => {
    const record = await genuineRecord(NOW - 1000);
    const trusted = deviceKeyField(record);
    const future: JsonObject = { ...NEWER, version: 3 };
    expect(await vettedField(trusted)).toBe(trusted);
    expect(await vettedField(future)).toBe(future);
    expect(await vettedField(undefined)).toBeUndefined();
    expect(await vettedField(null)).toBeUndefined();
    expect(
      await vettedField(deviceKeyField({ ...record, keyId: "F".repeat(43) })),
    ).toBeUndefined();
  });
});
