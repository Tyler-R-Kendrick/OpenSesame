/**
 * Keeping the tomb's identity key and the body's as one (ADR 0160 §5): every
 * row of the reconcile table, the deterministic winner when two devices each
 * minted a key, and what the person is told when this device's key loses.
 */

/** @vitest-environment jsdom */
import type { JsonObject } from "@opensesame/os-domain";
import {
  type DeviceIdentityKeyRecord,
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
import {
  type KeyCarryHost,
  keyForRestore,
  reconcileDeviceIdentityKey,
} from "./device-identity-carry.js";
import {
  readDeviceIdentityKey,
  writeStoredDeviceIdentityKey,
} from "./device-identity-key.js";
import { clearNotices, listNotices } from "./notices.js";
import { unlockTomb } from "./vfs.js";

async function openTomb(): Promise<string> {
  const tomb = `device-carry-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  return tomb;
}

type HeldBody = { field: JsonObject | undefined; published: number };

/** A body the test holds: a field, and a publish that ranks as the store does. */
function bodyHost(tomb: string, field?: JsonObject) {
  const held: HeldBody = { field, published: 0 };
  const host: KeyCarryHost = {
    tomb,
    carries: true,
    field: () => held.field,
    publish: async (next) => {
      held.published += 1;
      held.field = mergeDeviceKeyFields(held.field, next);
    },
  };
  return { host, held };
}

beforeEach(() => {
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
  clearNotices();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearNotices();
});

describe("reconciling the tomb's key with the body's", () => {
  it("does nothing when neither holds a key: the first use mints", async () => {
    const tomb = await openTomb();
    const { host, held } = bodyHost(tomb);
    await expect(reconcileDeviceIdentityKey(host)).resolves.toBe("none");
    expect(held.field).toBeUndefined();
    expect(await readDeviceIdentityKey(tomb)).toBeNull();
  });

  it("gives the tomb the body's key: a restore or a second device keeps the principal", async () => {
    const tomb = await openTomb();
    const carried = await genuineRecord(1_000);
    const { host } = bodyHost(tomb, deviceKeyField(carried));
    await expect(reconcileDeviceIdentityKey(host)).resolves.toBe("adopted");
    expect((await readDeviceIdentityKey(tomb))?.principalId).toBe(
      `prn_${carried.keyId}`,
    );
    // Nothing changed hands the other way, and no one is told: nothing was lost.
    expect(listNotices()).toEqual([]);
  });

  it("gives the body the tomb's key: a vault from before keys travelled", async () => {
    const tomb = await openTomb();
    const local = await genuineRecord(1_000);
    await writeStoredDeviceIdentityKey(tomb, local);
    const { host, held } = bodyHost(tomb);
    await expect(reconcileDeviceIdentityKey(host)).resolves.toBe("published");
    expect(readDeviceIdentityKeyRecord(held.field ?? {})?.keyId).toBe(
      local.keyId,
    );
  });

  it("does nothing when both hold the same key, and writes no body", async () => {
    const tomb = await openTomb();
    const key = await genuineRecord(1_000);
    await writeStoredDeviceIdentityKey(tomb, key);
    const { host, held } = bodyHost(tomb, deviceKeyField(key));
    await expect(reconcileDeviceIdentityKey(host)).resolves.toBe("same");
    expect(held.published).toBe(0);
    expect(listNotices()).toEqual([]);
  });

  it("is idempotent: a second pass finds nothing to do", async () => {
    const tomb = await openTomb();
    const { host } = bodyHost(tomb, await genuineField(1_000));
    await reconcileDeviceIdentityKey(host);
    await expect(reconcileDeviceIdentityKey(host)).resolves.toBe("same");
  });

  it("carries nothing for a guest or scratch tomb", async () => {
    const tomb = await openTomb();
    const { host } = bodyHost(tomb, await genuineField(1_000));
    await expect(
      reconcileDeviceIdentityKey({ ...host, carries: false }),
    ).resolves.toBe("skipped");
    expect(await readDeviceIdentityKey(tomb)).toBeNull();
  });
});

describe("two devices that each minted a key before they met", () => {
  it("the older key wins on the device that holds the newer one, and it says so", async () => {
    const tomb = await openTomb();
    const olderKey = await genuineRecord(1_000);
    const newerKey = await genuineRecord(2_000);
    await writeStoredDeviceIdentityKey(tomb, newerKey);
    const { host } = bodyHost(tomb, deviceKeyField(olderKey));
    await expect(reconcileDeviceIdentityKey(host)).resolves.toBe("replaced");
    expect((await readDeviceIdentityKey(tomb))?.keyId).toBe(olderKey.keyId);
    expect(listNotices()).toHaveLength(1);
    expect(listNotices()[0]).toMatchObject({
      kind: "status",
      title: "Device identity changed",
    });
  });

  it("the older key stays on the device that holds it, and the body is set to it", async () => {
    const tomb = await openTomb();
    const olderKey = await genuineRecord(1_000);
    const newerKey = await genuineRecord(2_000);
    await writeStoredDeviceIdentityKey(tomb, olderKey);
    const { host, held } = bodyHost(tomb, deviceKeyField(newerKey));
    await expect(reconcileDeviceIdentityKey(host)).resolves.toBe("published");
    expect((await readDeviceIdentityKey(tomb))?.keyId).toBe(olderKey.keyId);
    expect(readDeviceIdentityKeyRecord(held.field ?? {})?.keyId).toBe(
      olderKey.keyId,
    );
    // The key did not change here, so nothing is announced.
    expect(listNotices()).toEqual([]);
  });

  it("agrees whichever device reconciles first, down to the tie on time", async () => {
    // Same time on both: the smaller key id is the vault's, on every device.
    const a = await genuineRecord(5_000);
    const b = await genuineRecord(5_000);
    const smaller = a.keyId < b.keyId ? a : b;
    const larger = smaller === a ? b : a;
    const first = await openTomb();
    const second = await openTomb();
    await writeStoredDeviceIdentityKey(first, smaller);
    await writeStoredDeviceIdentityKey(second, larger);
    await reconcileDeviceIdentityKey(
      bodyHost(first, deviceKeyField(larger)).host,
    );
    await reconcileDeviceIdentityKey(
      bodyHost(second, deviceKeyField(smaller)).host,
    );
    expect((await readDeviceIdentityKey(first))?.keyId).toBe(smaller.keyId);
    expect((await readDeviceIdentityKey(second))?.keyId).toBe(smaller.keyId);
  });
});

describe("a record it cannot trust", () => {
  it("leaves a carried record of a newer version exactly as it is, on both sides", async () => {
    const tomb = await openTomb();
    const local = await genuineRecord(1_000);
    await writeStoredDeviceIdentityKey(tomb, local);
    const unknown: JsonObject = { version: 2, from: "a newer build" };
    const { host, held } = bodyHost(tomb, unknown);
    await expect(reconcileDeviceIdentityKey(host)).resolves.toBe("kept");
    expect(held.field).toBe(unknown);
    expect((await readDeviceIdentityKey(tomb))?.keyId).toBe(local.keyId);
  });

  it("leaves a carried key whose id is not its public key's thumbprint alone", async () => {
    const tomb = await openTomb();
    const liar: JsonObject = {
      ...(await genuineField(1_000)),
      keyId: "A".repeat(43),
    };
    const { host, held } = bodyHost(tomb, liar);
    await expect(reconcileDeviceIdentityKey(host)).resolves.toBe("kept");
    expect(held.field).toBe(liar);
    expect(await readDeviceIdentityKey(tomb)).toBeNull();
  });
});

describe("what a restore does with the key", () => {
  const mine = deviceKeyField({
    version: 1,
    keyId: "M".repeat(43),
    publicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    privateJwkJson: "{}",
    createdAt: 9_000,
  } satisfies DeviceIdentityKeyRecord);
  const theirs = deviceKeyField({
    version: 1,
    keyId: "T".repeat(43),
    publicJwk: { kty: "EC", crv: "P-256", x: "x2", y: "y2" },
    privateJwkJson: "{}",
    createdAt: 8_000,
  } satisfies DeviceIdentityKeyRecord);

  it("ranks the two keys when the backup is of this very vault", () => {
    const plan = keyForRestore({
      local: mine,
      incoming: theirs,
      sameVault: true,
      fresh: false,
    });
    expect(plan).toMatchObject({ field: theirs, withoutKey: false });
  });

  it("adopts the backup's key into a vault that has done nothing yet, whichever is older", () => {
    const plan = keyForRestore({
      local: mine,
      incoming: { ...theirs, createdAt: 99_999 },
      sameVault: false,
      fresh: true,
    });
    expect(plan.prefer).toBe("carried");
    expect(plan.withoutKey).toBe(false);
    expect(plan.field).toMatchObject({ keyId: "T".repeat(43) });
  });

  it("reports a backup with no key as restored without one", () => {
    const plan = keyForRestore({
      local: mine,
      incoming: undefined,
      sameVault: false,
      fresh: true,
    });
    expect(plan).toMatchObject({ field: mine, withoutKey: true });
  });

  it("keeps a vault's own key when it merges items from someone else's export", () => {
    const plan = keyForRestore({
      local: mine,
      incoming: theirs,
      sameVault: false,
      fresh: false,
    });
    expect(plan).toMatchObject({ field: mine, withoutKey: false });
  });
});
