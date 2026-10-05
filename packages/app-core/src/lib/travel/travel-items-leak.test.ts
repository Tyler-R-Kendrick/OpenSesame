/**
 * The leak test for hiding items (ADR 0170): real crypto, the real vault
 * store, the real activity log, the real files of the origin. Items carrying
 * distinctive strings leave a vault; afterwards no place this device keeps
 * anything the owner's key can open may still hold one — and the same run
 * with the purge steps switched off must find them, or the test proves
 * nothing.
 */

import {
  type VaultBody,
  type VaultItem,
  openJson,
  unlockVaultKey,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { beforeEach, describe, expect, it } from "vitest";
import { flushActivityLog, listActivityEvents } from "../activity-log.js";
import { appendHistoryEntry } from "../history-backup-idb.js";
import { passwordPreviouslyUsed } from "../vault/password-history.js";
import { vaultStore } from "../vault/store.js";
import { BODY_PATH, readSealedFile } from "../vfs.js";
import {
  openTravelItemsReturn,
  packTravelItemDeparture,
  returnItemsFromTravel,
} from "./index.js";
import { travelItemSeams } from "./items-deps.js";
import {
  KEEP,
  PASSWORD,
  S,
  clearTomb,
  hideThem,
  leaks,
  needlesOf,
  readableSurfaces,
  seedVault,
  useDurableStorage,
} from "./travel-items-leak.fixture.js";

beforeEach(async () => {
  await clearTomb();
  useDurableStorage();
});

describe("hiding items leaves nothing of them behind", () => {
  it("is findable before the hide: the seeded strings really are everywhere", async () => {
    const s = await seedVault();
    const tomb = vaultStore.getSnapshot().tomb;
    const key = await unlockVaultKey(
      vaultStore.getSnapshot().header as NonNullable<
        ReturnType<typeof vaultStore.getSnapshot>["header"]
      >,
      PASSWORD,
    );
    const { surfaces } = await readableSurfaces(tomb, key);
    const found = leaks(surfaces, needlesOf(s));
    expect(found.some((hit) => hit.startsWith("sealed body: "))).toBe(true);
    expect(found.some((hit) => hit.startsWith("activity log: "))).toBe(true);
    expect(
      await passwordPreviouslyUsed(`${tomb}\u0000${s.hide[2]}`, S.histOld),
    ).toBe(true);
  });

  it("leaves none of them in any surface the owner's key opens", async () => {
    const s = await seedVault();
    const tomb = vaultStore.getSnapshot().tomb;
    const key = await unlockVaultKey(
      vaultStore.getSnapshot().header as NonNullable<
        ReturnType<typeof vaultStore.getSnapshot>["header"]
      >,
      PASSWORD,
    );
    const { receipt } = await hideThem(s.hide);
    expect(receipt.completion).toBe("applied_local");
    expect(receipt.foldersRemoved).toBe(1);

    // The open store: items, trash, folders, what a search would index.
    const open = vaultStore.getSnapshot();
    expect(open.items.map((i) => i.name).sort()).toEqual(
      [KEEP.name, KEEP.note].sort(),
    );
    expect(JSON.stringify([open.items, open.folders])).not.toMatch(
      new RegExp(Object.values(S).join("|")),
    );
    expect(open.items.filter((i) => i.deletedAt !== null)).toEqual([]);

    // The next ordinary save writes a fresh sealed body: look inside it.
    const keeper = open.items.find((i) => i.name === KEEP.name);
    if (!keeper) throw new Error("keeper missing");
    await vaultStore.saveItem({
      ...keeper,
      notes: "edited after the trip began",
    });
    await flushActivityLog();

    const { surfaces, plain } = await readableSurfaces(tomb, key);
    expect(leaks(surfaces, needlesOf(s))).toEqual([]);
    // No tombstone names them either: a tombstone would delete them elsewhere.
    expect(plain.tombstones).toBeUndefined();
    // No retired password of theirs is recognised any more.
    expect(
      await passwordPreviouslyUsed(`${tomb}\u0000${s.hide[2]}`, S.histOld),
    ).toBe(false);
    // What stayed is untouched and still has its own history.
    expect(JSON.stringify(plain)).toContain(KEEP.password);
  });

  it("still holds after a lock and a fresh unlock, as at a border", async () => {
    const s = await seedVault();
    const tomb = vaultStore.getSnapshot().tomb;
    await hideThem(s.hide);
    vaultStore.lock();
    await vaultStore.unlock(PASSWORD);
    const header = vaultStore.getSnapshot().header;
    if (!header) throw new Error("no header");
    const key = await unlockVaultKey(header, PASSWORD);
    const { surfaces } = await readableSurfaces(tomb, key);
    expect(leaks(surfaces, needlesOf(s))).toEqual([]);
    expect(vaultStore.getSnapshot().items).toHaveLength(2);
  });

  it("returns them whole: ids, times, passwords, trash state, the folder", async () => {
    const s = await seedVault();
    const { pkg } = await hideThem(s.hide);
    const opened = await openTravelItemsReturn({
      bundleJson: pkg.bundleJson,
      returnCode: pkg.returnCode,
    });
    if (!opened.ok) throw new Error(opened.code);
    expect(opened.opened.preview.items.map((i) => i.status)).toEqual([
      "returns",
      "returns",
      "returns",
    ]);
    const back = await returnItemsFromTravel(opened.opened);
    expect(back).toMatchObject({ ok: true });
    await flushActivityLog();
    const now = vaultStore.getSnapshot();
    const byId = (items: readonly VaultItem[]) =>
      Object.fromEntries(items.map((item) => [item.id, item]));
    expect(byId(now.items)).toEqual(byId(s.before.items));
    expect(now.folders.map((f) => f.id).sort()).toEqual(
      s.before.folders.map((f) => f.id).sort(),
    );
    // Coming back is as quiet as leaving: no "created" line for them.
    const tomb = now.tomb;
    const lines = (await listActivityEvents(tomb)).map((e) => e.targetId);
    for (const id of s.hide) expect(lines).not.toContain(id);
    // And twice is once.
    const again = await openTravelItemsReturn({
      bundleJson: pkg.bundleJson,
      returnCode: pkg.returnCode,
    });
    if (!again.ok) throw new Error(again.code);
    await returnItemsFromTravel(again.opened);
    expect(vaultStore.getSnapshot().items).toHaveLength(s.before.items.length);
  });
});

describe("what the hide cannot reach, it refuses to run beside", () => {
  it("refuses while a history snapshot holds an older revision with them in it", async () => {
    const s = await seedVault();
    const tomb = vaultStore.getSnapshot().tomb;
    const key = await unlockVaultKey(
      vaultStore.getSnapshot().header as NonNullable<
        ReturnType<typeof vaultStore.getSnapshot>["header"]
      >,
      PASSWORD,
    );
    const older = readSealedFile(tomb, BODY_PATH);
    if (!older) throw new Error("no body");
    // An older sealed revision opens with the owner's key and holds the items:
    // exactly what a hide must not leave one of.
    const plain = await openJson<VaultBody>(
      key,
      older,
      vaultSealBinding(tomb, BODY_PATH),
    );
    expect(JSON.stringify(plain)).toContain(S.password);
    await appendHistoryEntry(
      "hacc_1",
      new TextEncoder().encode(JSON.stringify(older)),
    );
    expect(await packTravelItemDeparture(s.hide)).toMatchObject({
      ok: false,
      code: "copies_in_play",
      copies: ["history_snapshot"],
    });
    expect(vaultStore.getSnapshot().items).toHaveLength(5);
  });

  it("brings them back through a merge with a snapshot that still has them, the reason a paired drive refuses", async () => {
    const s = await seedVault();
    const tomb = vaultStore.getSnapshot().tomb;
    const snapshot = await vaultStore.sealedSnapshot();
    await hideThem(s.hide);
    expect(vaultStore.getSnapshot().items).toHaveLength(2);
    const merge = await vaultStore.mergeSnapshot({
      tomb,
      createdAt: snapshot.header.createdAt,
      body: snapshot.body,
      rev: snapshot.rev,
    });
    expect(merge.localChanged).toBe(true);
    expect(vaultStore.getSnapshot().items).toHaveLength(5);
  });
});

describe("the same walk with the purge steps off must find them", () => {
  it("finds the activity lines and the digests when nothing is purged", async () => {
    const s = await seedVault();
    const tomb = vaultStore.getSnapshot().tomb;
    const key = await unlockVaultKey(
      vaultStore.getSnapshot().header as NonNullable<
        ReturnType<typeof vaultStore.getSnapshot>["header"]
      >,
      PASSWORD,
    );
    travelItemSeams.deps = {
      ...travelItemSeams.deps,
      purge: {
        activity: async () => 0,
        passwords: async () => 0,
        offlineCache: async () => undefined,
      },
    };
    await hideThem(s.hide);
    const { surfaces } = await readableSurfaces(tomb, key);
    const found = leaks(surfaces, needlesOf(s));
    expect(found.some((hit) => hit.startsWith("activity log: "))).toBe(true);
    expect(
      await passwordPreviouslyUsed(`${tomb}\u0000${s.hide[2]}`, S.histOld),
    ).toBe(true);
  });

  it("finds them in a body when the removal is an ordinary purge: trash, tombstones", async () => {
    const s = await seedVault();
    const first = s.hide[0] as string;
    await vaultStore.trashItem(first);
    expect(
      vaultStore.getSnapshot().items.find((i) => i.id === first)?.deletedAt,
    ).not.toBeNull();
    await vaultStore.purgeItem(first);
    const header = vaultStore.getSnapshot().header;
    if (!header) throw new Error("no header");
    const key = await unlockVaultKey(header, PASSWORD);
    const { plain } = await readableSurfaces(
      vaultStore.getSnapshot().tomb,
      key,
    );
    // The ordinary removal names the id in a tombstone: a sync would delete
    // it elsewhere, and a person reading the body sees that it was there.
    expect(JSON.stringify(plain.tombstones)).toContain(first);
  });
});
