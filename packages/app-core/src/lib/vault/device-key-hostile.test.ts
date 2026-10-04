/**
 * A backup is whatever its author wrote, header and body alike (ADR 0160
 * §5a). Nothing in it ranks against a key the vault holds, so an author who
 * knows the victim's plaintext header time, and dates their key before it,
 * gains nothing: the vault keeps its principal unless its person asked for the
 * backup's identity and the vault had done nothing yet.
 */

/** @vitest-environment jsdom */
import type { JsonObject } from "@opensesame/os-domain";
import { createItem, deviceKeyField } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { genuineRecord } from "../__tests__/device-identity-records.js";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { deviceKeyCarrier } from "../device-identity-carrier.js";
import { readDeviceIdentityKey } from "../device-identity-key.js";
import { clearNotices, listNotices } from "../notices.js";
import { type Device, as, device } from "../tailnet-sync/devices.fixture.js";
import { offlineBackupFile, sealedVaultText } from "./offline-backup-file.js";
import { bodyPortOf, installDeviceKeyCarrier } from "./store-device-key.js";

const PASSWORD = "correct horse battery staple";
const TOMB = "personal";
const carrier = { ...deviceKeyCarrier };

beforeEach(() => {
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
  clearNotices();
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.assign(deviceKeyCarrier, carrier);
  clearNotices();
});

const acting = <T>(on: Device, act: () => Promise<T>) =>
  as(on, async () => {
    installDeviceKeyCarrier(() => bodyPortOf(on.store));
    return act();
  });

const principalOf = (on: Device) =>
  acting(on, async () => (await readDeviceIdentityKey(TOMB))?.principalId);

/** The person comes back to the vault. */
const reopen = (on: Device) => acting(on, () => on.store.unlock(PASSWORD));

/**
 * The victim: a member vault, with content or without, that has connected, so
 * its tomb holds a key. Returns the plaintext header time anyone can read.
 */
async function victim(withContent: boolean) {
  const on = device("victim");
  await acting(on, async () => {
    await on.store.create(PASSWORD);
    if (withContent) await on.store.saveItem(createItem("note", "Mine"));
    const { ensureDeviceIdentityKey } = await import(
      "../device-identity-key.js"
    );
    await ensureDeviceIdentityKey(TOMB);
    // Tombs are keyed by name in this process, so each device is locked while
    // another acts: the unlock below is what a person's next visit is.
    on.store.lock();
  });
  const createdAt = on.store.getSnapshot().header?.createdAt;
  await reopen(on);
  const principal = await principalOf(on);
  on.store.lock();
  return { on, createdAt, principal };
}

/**
 * The attacker's vault with a key they hold, dated as early as can be, in a
 * backup whose plaintext header is made to claim the victim's time.
 */
type Hostile = Readonly<{ text: string; theirs: string }>;

async function hostileBackup(claimed: string | undefined): Promise<Hostile> {
  const on = device("attacker");
  const theirs = await genuineRecord(1);
  const text = await acting(on, async () => {
    await on.store.create(PASSWORD);
    await bodyPortOf(on.store).mutate((body) => {
      body.deviceIdentityKey = deviceKeyField(theirs);
    });
    await on.store.flushPendingWrites();
    const { header, tomb } = on.store.getSnapshot();
    const file = offlineBackupFile({
      status: "unlocked",
      guest: false,
      tomb,
      header,
    }).text;
    const sealed: { header: JsonObject } = JSON.parse(sealedVaultText(file));
    if (claimed === undefined) {
      const { createdAt: _gone, ...rest } = sealed.header;
      sealed.header = rest;
    } else {
      sealed.header.createdAt = claimed;
    }
    on.store.lock();
    return JSON.stringify(sealed);
  });
  return { text, theirs: `prn_${theirs.keyId}` };
}

describe("a hostile backup into a member's vault", () => {
  it.each([
    ["with the victim's header time", true],
    ["with no header time at all", false],
  ])(
    "leaves the principal untouched %s, with or without the choice",
    async (_name, copies) => {
      const { on, createdAt, principal } = await victim(true);
      const hostile = await hostileBackup(copies ? createdAt : undefined);
      await reopen(on);
      for (const options of [{}, { adoptIdentity: true }]) {
        await acting(on, () =>
          on.store.importSealed(hostile.text, PASSWORD, options),
        );
        expect(await principalOf(on)).toBe(principal);
        expect(principal).not.toBe(hostile.theirs);
      }
      // The items still merged: only the identity is not for the taking.
      expect(on.store.getSnapshot().items.map((item) => item.name)).toEqual([
        "Mine",
      ]);
      expect(listNotices()).toEqual([]);
    },
  );
});

describe("a hostile backup into a fresh vault", () => {
  it("leaves the principal untouched unless the person chose to take it", async () => {
    const { on, createdAt, principal } = await victim(false);
    const hostile = await hostileBackup(createdAt);
    await reopen(on);
    await acting(on, () => on.store.importSealed(hostile.text, PASSWORD));
    expect(await principalOf(on)).toBe(principal);
    expect(listNotices()).toEqual([]);
  });

  it("takes it only when the person chose to, and says the principal changed", async () => {
    const { on, createdAt, principal } = await victim(false);
    const hostile = await hostileBackup(createdAt);
    await reopen(on);
    await acting(on, () =>
      on.store.importSealed(hostile.text, PASSWORD, { adoptIdentity: true }),
    );
    expect(await principalOf(on)).toBe(hostile.theirs);
    expect(hostile.theirs).not.toBe(principal);
    expect(listNotices().map((notice) => notice.title)).toEqual([
      "Device identity changed",
    ]);
  });
});
