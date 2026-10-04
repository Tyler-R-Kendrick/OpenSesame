/**
 * A key the vault body carries (ADR 0160 §5a): adopted instead of minted,
 * published when minted, healed when the body lacks it, and never minted
 * beside a carried record this build cannot trust.
 */

/** @vitest-environment jsdom */
import type { BoundaryValue, JsonObject } from "@opensesame/os-domain";
import {
  deviceKeyField,
  mergeDeviceKeyFields,
  mintVaultKey,
  readDeviceIdentityKeyRecord,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  genuineField,
  genuineRecord,
} from "./__tests__/device-identity-records.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { deviceKeyCarrier } from "./device-identity-carrier.js";
import {
  ensureDeviceIdentityKey,
  forgetDeviceIdentityKeyInFlightForTests,
  readDeviceIdentityKey,
} from "./device-identity-key.js";
import { vettedField } from "./device-identity-trust.js";
import { readFile, unlockTomb } from "./vfs.js";

const PATH = "config/device-identity-key";

async function openTomb(): Promise<string> {
  const tomb = `device-carried-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  return tomb;
}

const original = { ...deviceKeyCarrier };
let body: Map<string, BoundaryValue>;

beforeEach(() => {
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
  body = new Map();
  Object.assign(deviceKeyCarrier, {
    carried: (tomb: string) => body.get(tomb),
    // As the store's: the body's own key is vetted before it is ranked.
    publish: async (tomb: string, field: JsonObject) => {
      const own = await vettedField(body.get(tomb));
      body.set(tomb, mergeDeviceKeyFields(own, field) ?? field);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  forgetDeviceIdentityKeyInFlightForTests();
  Object.assign(deviceKeyCarrier, original);
});

describe("a key the vault body carries", () => {
  it("takes the carried key instead of minting one, and needs no lock to do it", async () => {
    const tomb = await openTomb();
    const carried = await genuineRecord(1_000);
    body.set(tomb, deviceKeyField(carried));
    vi.stubGlobal("navigator", {});
    const key = await ensureDeviceIdentityKey(tomb);
    expect(key.principalId).toBe(`prn_${carried.keyId}`);
    const sealed = new TextDecoder().decode(await readFile(tomb, PATH));
    expect(JSON.parse(sealed)).toEqual(carried);
  });

  it("puts a freshly minted key in the body, so the next backup holds it", async () => {
    const tomb = await openTomb();
    const key = await ensureDeviceIdentityKey(tomb);
    expect(readDeviceIdentityKeyRecord(body.get(tomb) ?? {})?.keyId).toBe(
      key.keyId,
    );
  });

  it("never writes the body when it only reads a key that exists", async () => {
    const tomb = await openTomb();
    await ensureDeviceIdentityKey(tomb);
    body.delete(tomb);
    const publish = vi.fn(async () => undefined);
    deviceKeyCarrier.publish = publish;
    forgetDeviceIdentityKeyInFlightForTests();
    // A tab answering Connect may be stale: the body is put right at unlock,
    // after a merge and at a mint, from the disk's copy, never from a read.
    await ensureDeviceIdentityKey(tomb);
    expect(publish).not.toHaveBeenCalled();
    expect(body.has(tomb)).toBe(false);
  });

  it("still gives a working key when the body cannot be written", async () => {
    const tomb = await openTomb();
    deviceKeyCarrier.publish = () => Promise.reject(new Error("disk full"));
    const key = await ensureDeviceIdentityKey(tomb);
    expect((await readDeviceIdentityKey(tomb))?.keyId).toBe(key.keyId);
  });

  it("refuses a carried record of a newer version, and mints nothing beside it", async () => {
    const tomb = await openTomb();
    const carried: JsonObject = { version: 2, from: "a newer build" };
    body.set(tomb, carried);
    await expect(ensureDeviceIdentityKey(tomb)).rejects.toMatchObject({
      code: "unreadable",
    });
    await expect(readFile(tomb, PATH)).rejects.toMatchObject({
      code: "not-found",
    });
    expect(body.get(tomb)).toBe(carried);
  });

  it("treats a forged carried record as no key: it mints, and the mint replaces the forgery", async () => {
    const forged: JsonObject = {
      ...(await genuineField(1)),
      keyId: "A".repeat(43),
    };
    for (const carried of [forged, null, "text", 7]) {
      const tomb = await openTomb();
      body.set(tomb, carried);
      const key = await ensureDeviceIdentityKey(tomb);
      expect(key.keyId).not.toBe("A".repeat(43));
      expect(readDeviceIdentityKeyRecord(body.get(tomb) ?? {})?.keyId).toBe(
        key.keyId,
      );
      forgetDeviceIdentityKeyInFlightForTests();
    }
  });

  it("with nothing carried and no lock, mints nothing", async () => {
    vi.stubGlobal("navigator", {});
    const tomb = await openTomb();
    await expect(ensureDeviceIdentityKey(tomb)).rejects.toMatchObject({
      code: "no-fence",
    });
    expect(body.has(tomb)).toBe(false);
  });
});
