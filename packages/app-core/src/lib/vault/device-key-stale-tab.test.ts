/**
 * Two tabs on one vault (ADR 0160 §5a). A tab that answers Connect may hold a
 * body another tab has since changed. The identity key's writes to the body
 * start from the disk's copy under the cross-tab body lock, and a plain read of
 * the principal writes nothing, so a stale tab never drops the other tab's edit
 * and never seals a revision the header has moved past (which the next unlock
 * would call a rollback).
 */

import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { genuineRecord } from "../__tests__/device-identity-records.js";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { deviceKeyCarrier } from "../device-identity-carrier.js";
import {
  ensureDeviceIdentityKey,
  forgetDeviceIdentityKeyInFlightForTests,
  writeStoredDeviceIdentityKey,
} from "../device-identity-key.js";
import { kvDelete } from "../kv.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "../vfs.js";
import { bodyPortOf, installDeviceKeyCarrier } from "./store-device-key.js";
import { ATTEMPTS_KEY, VaultStore } from "./store.js";

const PASSWORD = "correct horse battery staple";
const carrier = { ...deviceKeyCarrier };

function wipe(): void {
  for (const path of [
    BODY_PATH,
    HEADER_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
    "config/device-identity-key",
  ]) {
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  }
  kvDelete(ATTEMPTS_KEY);
  forgetDeviceIdentityKeyInFlightForTests();
}

beforeEach(async () => {
  await vfsFlush();
  wipe();
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
});

afterEach(async () => {
  await vfsFlush();
  vi.unstubAllGlobals();
  Object.assign(deviceKeyCarrier, carrier);
});

/** Tab A made the vault; tab B opened it too and then edited it, so A is stale. */
async function staleTab() {
  const a = new VaultStore();
  await a.create(PASSWORD);
  await a.flushPendingWrites();
  await vfsFlush();
  const b = new VaultStore();
  b.rehydrate();
  await b.unlock(PASSWORD);
  await b.saveItem(createItem("note", "Written in tab B"));
  await b.flushPendingWrites();
  await vfsFlush();
  expect(a.getSnapshot().items).toHaveLength(0);
  return { a, b };
}

/** The next visit: a new tab opens the vault from the disk. */
async function nextVisit(): Promise<VaultStore> {
  const c = new VaultStore();
  c.rehydrate();
  await c.unlock(PASSWORD);
  return c;
}

describe("a stale tab answering Connect", () => {
  it("minting a key does not lose the other tab's edit, and the next unlock opens", async () => {
    const { a } = await staleTab();
    installDeviceKeyCarrier(() => bodyPortOf(a));
    const key = await ensureDeviceIdentityKey(PERSONAL_TOMB);
    await a.flushPendingWrites();
    await vfsFlush();

    const c = await nextVisit();
    expect(c.getSnapshot().items.map((item) => item.name)).toEqual([
      "Written in tab B",
    ]);
    expect(bodyPortOf(c).body().deviceIdentityKey).toMatchObject({
      keyId: key.keyId,
    });
    // The stale tab now shows what is on disk, not what it loaded.
    expect(a.getSnapshot().items.map((item) => item.name)).toEqual([
      "Written in tab B",
    ]);
  });

  it("reading a key that exists writes nothing, so the other tab's edit stands", async () => {
    const { a } = await staleTab();
    await writeStoredDeviceIdentityKey(
      PERSONAL_TOMB,
      await genuineRecord(Date.now() - 1000),
    );
    installDeviceKeyCarrier(() => bodyPortOf(a));
    const publish = vi.spyOn(deviceKeyCarrier, "publish");
    await ensureDeviceIdentityKey(PERSONAL_TOMB);
    await a.flushPendingWrites();
    await vfsFlush();
    expect(publish).not.toHaveBeenCalled();

    const c = await nextVisit();
    expect(c.getSnapshot().items.map((item) => item.name)).toEqual([
      "Written in tab B",
    ]);
  });
});
