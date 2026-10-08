/**
 * Keeping the tomb's identity key and the body's as one (ADR 0160 §5a): every
 * row of the reconcile table, the deterministic winner when two devices each
 * minted a key, a body that carries something that is not a key, and what the
 * person is told in each case.
 */

/** @vitest-environment jsdom */
import type { BoundaryValue, JsonObject } from "@opensesame/os-domain";
import {
  DEVICE_KEY_CLOCK_MARGIN_MS,
  type DeviceKeyTimeBounds,
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
  type IdentityChange,
  type KeyCarryHost,
  noteDeviceIdentityChanged,
  reconcileDeviceIdentityKey,
} from "./device-identity-carry.js";
import {
  readDeviceIdentityKey,
  withDeviceIdentityFence,
  writeStoredDeviceIdentityKey,
} from "./device-identity-key.js";
import { vettedField } from "./device-identity-trust.js";
import { clearNotices, listNotices } from "./notices.js";
import { unlockTomb } from "./vfs.js";

async function openTomb(): Promise<string> {
  const tomb = `device-carry-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  return tomb;
}

type HeldBody = { field: BoundaryValue; published: number };

/**
 * A body the test holds, and a publish that behaves as the store's does: the
 * body's own key is vetted first, then ranked against the one offered.
 */
function bodyHost(
  tomb: string,
  field?: BoundaryValue,
  bounds: DeviceKeyTimeBounds = { now: Date.now(), notBefore: 1 },
) {
  const held: HeldBody = { field, published: 0 };
  const host: KeyCarryHost = {
    tomb,
    carries: true,
    field: () => held.field,
    bounds: () => bounds,
    publish: async (next) => {
      held.published += 1;
      const own = await vettedField(held.field, bounds);
      held.field = mergeDeviceKeyFields(own, next);
    },
  };
  return { host, held };
}

const keyIdOf = (field: BoundaryValue) =>
  readDeviceIdentityKeyRecord(field)?.keyId;

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

  it("gives the tomb the body's key: a second device keeps the principal", async () => {
    const tomb = await openTomb();
    const carried = await genuineRecord(Date.now() - 1000);
    const { host } = bodyHost(tomb, deviceKeyField(carried));
    await expect(reconcileDeviceIdentityKey(host)).resolves.toBe("adopted");
    expect((await readDeviceIdentityKey(tomb))?.principalId).toBe(
      `prn_${carried.keyId}`,
    );
    expect(listNotices()).toEqual([]);
  });

  it("gives the body the tomb's key: a vault from before keys travelled", async () => {
    const tomb = await openTomb();
    const local = await genuineRecord(Date.now() - 1000);
    await writeStoredDeviceIdentityKey(tomb, local);
    const { host, held } = bodyHost(tomb);
    await expect(reconcileDeviceIdentityKey(host)).resolves.toBe("published");
    expect(keyIdOf(held.field)).toBe(local.keyId);
  });

  it("does nothing when both hold the same key, and writes no body", async () => {
    const tomb = await openTomb();
    const key = await genuineRecord(Date.now() - 1000);
    await writeStoredDeviceIdentityKey(tomb, key);
    const { host, held } = bodyHost(tomb, deviceKeyField(key));
    await expect(reconcileDeviceIdentityKey(host)).resolves.toBe("same");
    expect(held.published).toBe(0);
    expect(listNotices()).toEqual([]);
  });

  it("is idempotent: a second pass finds nothing to do", async () => {
    const tomb = await openTomb();
    const { host } = bodyHost(tomb, await genuineField(Date.now() - 1000));
    await reconcileDeviceIdentityKey(host);
    await expect(reconcileDeviceIdentityKey(host)).resolves.toBe("same");
  });

  it("carries nothing for a guest or scratch tomb", async () => {
    const tomb = await openTomb();
    const { host } = bodyHost(tomb, await genuineField(Date.now() - 1000));
    await expect(
      reconcileDeviceIdentityKey({ ...host, carries: false }),
    ).resolves.toBe("skipped");
    expect(await readDeviceIdentityKey(tomb)).toBeNull();
  });

  it("does not take the lock again when the caller holds it", async () => {
    const locks = webLocksDouble();
    vi.stubGlobal("navigator", { locks });
    const tomb = await openTomb();
    const { host } = bodyHost(tomb, await genuineField(Date.now() - 1000));
    await expect(
      withDeviceIdentityFence(tomb, () =>
        reconcileDeviceIdentityKey(host, { held: true }),
      ),
    ).resolves.toBe("adopted");
    const identityLock = `opensesame-device-identity-${tomb}`;
    expect(locks.requested.filter((name) => name === identityLock)).toEqual([
      identityLock,
    ]);
    expect(locks.requested).toContain(`opensesame:vfs-rotation:${tomb}`);
  });
});

describe("two devices that each minted a key before they met", () => {
  it("the older key wins on the device that holds the newer one, and it says so", async () => {
    const tomb = await openTomb();
    const olderKey = await genuineRecord(Date.now() - 2000);
    const newerKey = await genuineRecord(Date.now() - 1000);
    await writeStoredDeviceIdentityKey(tomb, newerKey);
    const { host } = bodyHost(tomb, deviceKeyField(olderKey));
    await expect(reconcileDeviceIdentityKey(host)).resolves.toBe("replaced");
    expect((await readDeviceIdentityKey(tomb))?.keyId).toBe(olderKey.keyId);
    expect(listNotices()).toHaveLength(1);
    expect(listNotices()[0]).toMatchObject({
      kind: "status",
      title: "Device identity changed",
      body: expect.stringContaining("already carried an older identity key"),
    });
  });

  it("the older key stays on the device that holds it, and the body is set to it", async () => {
    const tomb = await openTomb();
    const olderKey = await genuineRecord(Date.now() - 2000);
    const newerKey = await genuineRecord(Date.now() - 1000);
    await writeStoredDeviceIdentityKey(tomb, olderKey);
    const { host, held } = bodyHost(tomb, deviceKeyField(newerKey));
    await expect(reconcileDeviceIdentityKey(host)).resolves.toBe("published");
    expect((await readDeviceIdentityKey(tomb))?.keyId).toBe(olderKey.keyId);
    expect(keyIdOf(held.field)).toBe(olderKey.keyId);
    expect(listNotices()).toEqual([]);
  });

  it("agrees whichever device reconciles first, down to the tie on time", async () => {
    const at = Date.now() - 5000;
    const a = await genuineRecord(at);
    const b = await genuineRecord(at);
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

describe("a body that carries something that is not a key", () => {
  /** Records that look like keys, or like nothing, and are neither. */
  async function poisons(): Promise<(readonly [string, BoundaryValue])[]> {
    const genuine = await genuineRecord(Date.now() - 1000);
    const other = await genuineRecord(Date.now() - 1000);
    return [
      [
        "a forged id with the oldest possible time",
        deviceKeyField({ ...genuine, keyId: "F".repeat(43), createdAt: 1 }),
      ],
      [
        "another key's private half",
        deviceKeyField({
          ...genuine,
          createdAt: 1,
          privateJwkJson: other.privateJwkJson,
        }),
      ],
      [
        "a time past the clock margin",
        deviceKeyField({
          ...genuine,
          createdAt: Date.now() + DEVICE_KEY_CLOCK_MARGIN_MS * 3,
        }),
      ],
      ["null", null],
      ["a string", "a key"],
      ["a number", 7],
    ];
  }

  it("never beats the tomb's genuine key, however old it claims to be, and is replaced by it", async () => {
    for (const [name, poison] of await poisons()) {
      const tomb = await openTomb();
      const local = await genuineRecord(Date.now() - 1000);
      await writeStoredDeviceIdentityKey(tomb, local);
      const { host, held } = bodyHost(tomb, poison);
      await expect(reconcileDeviceIdentityKey(host), name).resolves.toBe(
        "published",
      );
      expect((await readDeviceIdentityKey(tomb))?.keyId, name).toBe(
        local.keyId,
      );
      expect(keyIdOf(held.field), name).toBe(local.keyId);
      expect(listNotices(), name).toEqual([]);
    }
  });

  it("is never adopted into a tomb that has no key, and does not leave it unreadable", async () => {
    for (const [name, poison] of await poisons()) {
      const tomb = await openTomb();
      const { host } = bodyHost(tomb, poison);
      await expect(reconcileDeviceIdentityKey(host), name).resolves.toBe(
        "none",
      );
      expect(await readDeviceIdentityKey(tomb), name).toBeNull();
    }
  });

  it("leaves a record of a newer version alone on both sides", async () => {
    const tomb = await openTomb();
    const local = await genuineRecord(Date.now() - 1000);
    await writeStoredDeviceIdentityKey(tomb, local);
    const unknown: JsonObject = {
      version: 2,
      keyId: "k".repeat(43),
      publicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      from: "a newer build",
    };
    const { host, held } = bodyHost(tomb, unknown);
    await expect(reconcileDeviceIdentityKey(host)).resolves.toBe("kept");
    expect(held.field).toBe(unknown);
    expect((await readDeviceIdentityKey(tomb))?.keyId).toBe(local.keyId);
  });
});

describe("a tomb key dated outside the vault's window", () => {
  const DAY = DEVICE_KEY_CLOCK_MARGIN_MS;
  const now = 1_790_000_000_000;
  const bounds = { now, notBefore: now - 30 * DAY };

  /** What the body would hold, read back the way every reader reads it. */
  const readBack = (field: BoundaryValue) =>
    readDeviceIdentityKeyRecord(field, now, bounds.notBefore);

  it("is published dated no later than now, and read back as the same key", async () => {
    const tomb = await openTomb();
    const local = await genuineRecord(now + 3 * DAY);
    await writeStoredDeviceIdentityKey(tomb, local);
    const { host, held } = bodyHost(tomb, undefined, bounds);
    await expect(reconcileDeviceIdentityKey(host)).resolves.toBe("published");
    expect(readBack(held.field)?.keyId).toBe(local.keyId);
    expect(readBack(held.field)?.createdAt).toBe(now);
  });

  it("is published dated no earlier than the window opens", async () => {
    const tomb = await openTomb();
    const local = await genuineRecord(7);
    await writeStoredDeviceIdentityKey(tomb, local);
    const { host, held } = bodyHost(tomb, undefined, bounds);
    await expect(reconcileDeviceIdentityKey(host)).resolves.toBe("published");
    expect(readBack(held.field)?.createdAt).toBe(bounds.notBefore);
  });

  it("is then the same key: a second pass publishes nothing", async () => {
    const tomb = await openTomb();
    await writeStoredDeviceIdentityKey(
      tomb,
      await genuineRecord(now + 3 * DAY),
    );
    const { host, held } = bodyHost(tomb, undefined, bounds);
    await reconcileDeviceIdentityKey(host);
    await expect(reconcileDeviceIdentityKey(host)).resolves.toBe("same");
    expect(held.published).toBe(1);
  });

  it("ranks by the date it is published under, so a forged future date does not lose to an honest key", async () => {
    const tomb = await openTomb();
    const local = await genuineRecord(now + 3 * DAY);
    await writeStoredDeviceIdentityKey(tomb, local);
    // An honest key a few hours ahead of this clock, inside the margin.
    const carried = await genuineRecord(now + 3 * 60 * 60 * 1000);
    const { host, held } = bodyHost(tomb, deviceKeyField(carried), bounds);
    await expect(reconcileDeviceIdentityKey(host)).resolves.toBe("published");
    expect(readBack(held.field)?.keyId).toBe(local.keyId);
  });
});

describe("what the person is told", () => {
  const cases = [
    ["ranked", "Device identity changed", "already carried an older"],
    [
      "restored",
      "Device identity changed",
      "You took the backup's identity key",
    ],
    [
      "restored-without-key",
      "Restored without an identity key",
      "carries no identity key",
    ],
    ["restored-unusable", "Identity key not taken", "cannot use"],
    [
      "own-unreadable",
      "Identity key not taken",
      "own identity key could not be read",
    ],
  ] as const satisfies readonly (readonly [IdentityChange, string, string])[];

  it.each(cases)("says %s in its own words", (cause, title, body) => {
    noteDeviceIdentityChanged(cause);
    expect(listNotices()).toHaveLength(1);
    expect(listNotices()[0]).toMatchObject({
      title,
      body: expect.stringContaining(body),
    });
  });

  it("never says the backup's key is older when the person took it", () => {
    noteDeviceIdentityChanged("restored");
    expect(listNotices()[0]?.body).not.toMatch(/older/);
  });

  it("never says a backup carries no key when its key was one this build cannot use", () => {
    noteDeviceIdentityChanged("restored-unusable");
    expect(listNotices()[0]?.body).not.toMatch(/carries no identity key/);
  });
});
