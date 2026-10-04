/**
 * When each installed item type was installed (`itemTypesAt`, ADR 0144) is
 * what lets a later uninstall elsewhere lose to a reinstall here. It lives in
 * the sealed body, so it must come back when the vault opens, and a write that
 * fails must put it back with the rest of the body.
 */

import { readFileSync } from "node:fs";
import {
  type VaultBody,
  emptyBody,
  syncInstalledTypes,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kvDelete } from "../kv.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
  vfsSeams,
} from "../vfs.js";
import { bodyBeforeWrite } from "./body-edits.js";
import { bodyPortOf } from "./store-device-key.js";
import { VaultStore } from "./store.js";

const PASSWORD = "correct horse battery staple";
const LOCK = readFileSync(
  new URL(
    "../../../../../marketplace/item-types/optional/combination-lock.json",
    import.meta.url,
  ),
  "utf8",
);
const LOCK_ID = "combination-lock";

function wipe(): void {
  for (const path of [
    BODY_PATH,
    HEADER_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
  ]) {
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  }
}

beforeEach(async () => {
  await vfsFlush();
  wipe();
});

afterEach(() => {
  syncInstalledTypes({});
});

function openBody(store: VaultStore): VaultBody {
  return bodyPortOf(store).body();
}

describe("itemTypesAt across an unlock", () => {
  it("is restored with the item types when the vault opens again", async () => {
    const first = new VaultStore();
    await first.create(PASSWORD);
    expect((await first.installItemTypeDefinition(LOCK)).ok).toBe(true);
    const stamped = openBody(first).itemTypesAt?.[LOCK_ID];
    expect(stamped).toMatch(/^\d{4}-/);
    await first.flushPendingWrites();
    await vfsFlush();
    first.lock();
    syncInstalledTypes({});

    // A reload: another store over the same files.
    const second = new VaultStore();
    await second.unlock(PASSWORD);
    expect(Object.keys(openBody(second).itemTypes ?? {})).toEqual([LOCK_ID]);
    expect(openBody(second).itemTypesAt).toEqual({ [LOCK_ID]: stamped });
    second.lock();
  });

  it("survives the next write: the stamp is not dropped from the sealed file", async () => {
    const first = new VaultStore();
    await first.create(PASSWORD);
    await first.installItemTypeDefinition(LOCK);
    const stamped = openBody(first).itemTypesAt?.[LOCK_ID];
    await first.flushPendingWrites();
    await vfsFlush();
    first.lock();
    syncInstalledTypes({});

    const second = new VaultStore();
    await second.unlock(PASSWORD);
    await second.addFolder("Later");
    await second.flushPendingWrites();
    await vfsFlush();
    second.lock();
    syncInstalledTypes({});

    const third = new VaultStore();
    await third.unlock(PASSWORD);
    expect(openBody(third).itemTypesAt).toEqual({ [LOCK_ID]: stamped });
    third.lock();
  });
});

describe("itemTypesAt when a write fails", () => {
  it("bodyBeforeWrite keeps it", () => {
    const body: VaultBody = {
      ...emptyBody(),
      itemTypes: { [LOCK_ID]: LOCK },
      itemTypesAt: { [LOCK_ID]: "2026-10-04T00:00:00.000Z" },
    };
    expect(bodyBeforeWrite(body).itemTypesAt).toEqual({
      [LOCK_ID]: "2026-10-04T00:00:00.000Z",
    });
  });

  it("a failed seal puts the stamps back with the body", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await store.installItemTypeDefinition(LOCK);
    const stamped = openBody(store).itemTypesAt?.[LOCK_ID];
    await store.flushPendingWrites();
    await vfsFlush();

    const write = vfsSeams.writeRaw;
    vfsSeams.writeRaw = () => Promise.reject(new Error("disk full"));
    try {
      await expect(store.addFolder("Never")).rejects.toThrow("disk full");
    } finally {
      vfsSeams.writeRaw = write;
    }
    expect(openBody(store).folders).toEqual([]);
    expect(openBody(store).itemTypesAt).toEqual({ [LOCK_ID]: stamped });
    store.lock();
  });
});
