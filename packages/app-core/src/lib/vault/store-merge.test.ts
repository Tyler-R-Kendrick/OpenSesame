import { createItem } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it } from "vitest";
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
import type { SealedSnapshot } from "./store-merge.js";
import { VaultCorruptError, VaultStore } from "./store.js";

const PASSWORD = "correct horse battery staple";

function input(snapshot: SealedSnapshot) {
  return {
    tomb: snapshot.tomb,
    createdAt: snapshot.header.createdAt,
    body: snapshot.body,
    rev: snapshot.rev,
  };
}

async function unlockedWith(...names: string[]) {
  const store = new VaultStore();
  await store.create(PASSWORD);
  const ids: string[] = [];
  for (const name of names) {
    const item = createItem("note", name);
    ids.push(item.id);
    await store.saveItem(item);
  }
  return { store, ids };
}

const names = (store: VaultStore) =>
  store
    .getSnapshot()
    .items.map((item) => item.name)
    .sort();

beforeEach(async () => {
  await vfsFlush();
  for (const path of [
    HEADER_PATH,
    BODY_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
  ]) {
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  }
});

describe("VaultStore.mergeSnapshot", () => {
  it("does not bring back an item purged after the snapshot was taken", async () => {
    const { store, ids } = await unlockedWith("a", "b");
    const before = await store.sealedSnapshot();
    await store.purgeItem(ids[0] ?? "");
    const merge = await store.mergeSnapshot(input(before));
    expect(merge).toEqual({ localChanged: false, remoteBehind: true });
    expect(names(store)).toEqual(["b"]);
  });

  it("takes in what only the snapshot holds and reports nothing to push back", async () => {
    const { store } = await unlockedWith("a", "b");
    const remote = await store.sealedSnapshot();
    // This device loses "b" without a purge: the other device still has it.
    const kept = store.getSnapshot().items.filter((item) => item.name === "a");
    await store.replaceAll(kept, []);
    const merge = await store.mergeSnapshot(input(remote));
    expect(merge).toEqual({ localChanged: true, remoteBehind: false });
    expect(names(store)).toEqual(["a", "b"]);
  });

  it("is a no-op against its own latest snapshot", async () => {
    const { store } = await unlockedWith("a");
    const { rev } = await store.sealedSnapshot();
    const merge = await store.mergeSnapshot(
      input(await store.sealedSnapshot()),
    );
    expect(merge).toEqual({ localChanged: false, remoteBehind: false });
    expect((await store.sealedSnapshot()).rev).toBe(rev);
  });

  it("refuses a snapshot of another vault", async () => {
    const { store } = await unlockedWith("a");
    const snapshot = await store.sealedSnapshot();
    await expect(
      store.mergeSnapshot({ ...input(snapshot), createdAt: "1999-01-01" }),
    ).rejects.toBeInstanceOf(VaultCorruptError);
  });

  it("refuses a snapshot whose revision disagrees with its sealed body", async () => {
    const { store } = await unlockedWith("a");
    const snapshot = await store.sealedSnapshot();
    await expect(
      store.mergeSnapshot({ ...input(snapshot), rev: snapshot.rev + 1 }),
    ).rejects.toBeInstanceOf(VaultCorruptError);
  });

  it("refuses a body sealed for a different tomb path", async () => {
    const { store } = await unlockedWith("a");
    const snapshot = await store.sealedSnapshot();
    await expect(
      store.mergeSnapshot({ ...input(snapshot), tomb: "project-x" }),
    ).rejects.toBeInstanceOf(VaultCorruptError);
  });
});
