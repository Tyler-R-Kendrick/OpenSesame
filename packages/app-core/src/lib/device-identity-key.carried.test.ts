/**
 * A key the vault body carries (ADR 0160 §5): adopted instead of minted,
 * published when minted, healed when the body lacks it, and never minted
 * beside a carried record this build cannot trust.
 */

/** @vitest-environment jsdom */
import type { JsonObject } from "@opensesame/os-domain";
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
import { readFile, unlockTomb } from "./vfs.js";

const PATH = "config/device-identity-key";

async function openTomb(): Promise<string> {
  const tomb = `device-carried-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  return tomb;
}

const original = { ...deviceKeyCarrier };
let body: Map<string, JsonObject>;

beforeEach(() => {
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
  body = new Map();
  Object.assign(deviceKeyCarrier, {
    carried: (tomb: string) => body.get(tomb),
    publish: async (tomb: string, field: JsonObject) => {
      body.set(tomb, mergeDeviceKeyFields(body.get(tomb), field) ?? field);
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

  it("puts a key the body lacks into it on a later read", async () => {
    const tomb = await openTomb();
    const key = await ensureDeviceIdentityKey(tomb);
    body.delete(tomb);
    forgetDeviceIdentityKeyInFlightForTests();
    expect((await ensureDeviceIdentityKey(tomb)).keyId).toBe(key.keyId);
    expect(readDeviceIdentityKeyRecord(body.get(tomb) ?? {})?.keyId).toBe(
      key.keyId,
    );
  });

  it("still gives a working key when the body cannot be written", async () => {
    const tomb = await openTomb();
    deviceKeyCarrier.publish = () => Promise.reject(new Error("disk full"));
    const key = await ensureDeviceIdentityKey(tomb);
    expect((await readDeviceIdentityKey(tomb))?.keyId).toBe(key.keyId);
  });

  it("refuses a carried record it cannot trust, and mints nothing beside it", async () => {
    const records: JsonObject[] = [
      { version: 2, from: "a newer build" },
      { ...(await genuineField(1_000)), keyId: "A".repeat(43) },
    ];
    for (const carried of records) {
      const tomb = await openTomb();
      body.set(tomb, carried);
      await expect(ensureDeviceIdentityKey(tomb)).rejects.toMatchObject({
        code: "unreadable",
      });
      await expect(readFile(tomb, PATH)).rejects.toMatchObject({
        code: "not-found",
      });
      expect(body.get(tomb)).toBe(carried);
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
