import { describe, expect, it } from "vitest";
import {
  MAX_TOMBSTONES,
  mergeVaultBodies,
  sameVaultContent,
  withTombstone,
} from "./merge.js";
import { type VaultBody, type VaultItem, createItem } from "./model.js";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";
const T2 = "2026-01-03T00:00:00.000Z";

function note(id: string, updatedAt = T0, folderId: string | null = null) {
  return {
    ...createItem("note", id),
    id,
    folderId,
    createdAt: T0,
    updatedAt,
  } satisfies VaultItem;
}

function body(partial: Partial<VaultBody>): VaultBody {
  return { v: 1, items: [], folders: [], ...partial };
}

describe("mergeVaultBodies tombstones", () => {
  it("keeps a purged item purged when the other side still holds it", () => {
    const purged = body({
      tombstones: withTombstone(undefined, "items", ["a"], T1),
    });
    const stale = body({ items: [note("a", T0)] });
    expect(mergeVaultBodies(purged, stale).items).toEqual([]);
    expect(mergeVaultBodies(stale, purged).items).toEqual([]);
  });

  it("lets an edit made after the purge survive it", () => {
    const purged = body({
      tombstones: withTombstone(undefined, "items", ["a"], T1),
    });
    const edited = body({ items: [note("a", T2)] });
    expect(mergeVaultBodies(purged, edited).items.map((i) => i.id)).toEqual([
      "a",
    ]);
  });

  it("drops a deleted folder and moves its items to the root on both sides", () => {
    const deleted = body({
      tombstones: withTombstone(undefined, "folders", ["f"], T1),
    });
    const stale = body({
      folders: [{ id: "f", name: "Work", createdAt: T0 }],
      items: [note("a", T0, "f")],
    });
    const merged = mergeVaultBodies(stale, deleted);
    expect(merged.folders).toEqual([]);
    expect(merged.items[0]?.folderId).toBeNull();
    expect(sameVaultContent(merged, mergeVaultBodies(deleted, stale))).toBe(
      true,
    );
  });

  it("keeps the later time when both sides tombstoned the same id", () => {
    const a = body({
      tombstones: withTombstone(undefined, "items", ["x"], T0),
    });
    const b = body({
      tombstones: withTombstone(undefined, "items", ["x"], T2),
    });
    expect(mergeVaultBodies(a, b).tombstones?.items).toEqual({ x: T2 });
    expect(mergeVaultBodies(b, a).tombstones?.items).toEqual({ x: T2 });
  });

  it("leaves tombstones off a merge of two bodies that never had any", () => {
    expect("tombstones" in mergeVaultBodies(body({}), body({}))).toBe(false);
  });

  it("forgets the oldest tombstones past the cap", () => {
    const ids = Array.from({ length: MAX_TOMBSTONES + 2 }, (_, n) => `i${n}`);
    let tombs = withTombstone(undefined, "items", ids.slice(0, 2), T0);
    tombs = withTombstone(tombs, "items", ids.slice(2), T1);
    const kept = Object.keys(tombs.items ?? {});
    expect(kept).toHaveLength(MAX_TOMBSTONES);
    expect(kept).not.toContain("i0");
  });
});

describe("sameVaultContent", () => {
  it("ignores order and write counters", () => {
    const a = body({ items: [note("a"), note("b")], rev: 3 });
    const b = body({ items: [note("b"), note("a")], rev: 9 });
    expect(sameVaultContent(a, b)).toBe(true);
  });

  it("sees an item edit", () => {
    expect(
      sameVaultContent(
        body({ items: [note("a", T0)] }),
        body({ items: [note("a", T1)] }),
      ),
    ).toBe(false);
  });

  it("sees a new tombstone", () => {
    expect(
      sameVaultContent(
        body({}),
        body({ tombstones: withTombstone(undefined, "items", ["z"], T0) }),
      ),
    ).toBe(false);
  });
});

describe("mergeVaultBodies edits that carry no item content", () => {
  it("keeps the later folder rename, whichever name sorts higher", () => {
    const folder = { id: "f", name: "Work", createdAt: T0 };
    const renamed = body({
      folders: [{ ...folder, name: "Alpha", updatedAt: T1 }],
    });
    const stale = body({ folders: [folder] });
    for (const merged of [
      mergeVaultBodies(renamed, stale),
      mergeVaultBodies(stale, renamed),
    ]) {
      expect(merged.folders.map((f) => f.name)).toEqual(["Alpha"]);
    }
  });

  it("keeps an item type uninstalled against a device that still has it", () => {
    const installed = body({
      itemTypes: { t: "{}" },
      itemTypesAt: { t: T0 },
    });
    const uninstalled = body({
      tombstones: withTombstone(undefined, "itemTypes", ["t"], T1),
    });
    for (const merged of [
      mergeVaultBodies(installed, uninstalled),
      mergeVaultBodies(uninstalled, installed),
    ]) {
      expect(merged.itemTypes).toBeUndefined();
      expect(merged.itemTypesAt).toBeUndefined();
      expect(merged.tombstones?.itemTypes).toEqual({ t: T1 });
    }
  });

  it("lets an install made after the uninstall survive it", () => {
    const reinstalled = body({
      itemTypes: { t: '{"v":2}' },
      itemTypesAt: { t: T2 },
    });
    const uninstalled = body({
      itemTypes: {},
      tombstones: withTombstone(undefined, "itemTypes", ["t"], T1),
    });
    const merged = mergeVaultBodies(uninstalled, reinstalled);
    expect(merged.itemTypes).toEqual({ t: '{"v":2}' });
    expect(merged.itemTypesAt).toEqual({ t: T2 });
    expect(
      sameVaultContent(merged, mergeVaultBodies(reinstalled, uninstalled)),
    ).toBe(true);
  });

  it("takes the later install's text on a clash, in either order", () => {
    const older = body({ itemTypes: { t: '{"z":1}' }, itemTypesAt: { t: T0 } });
    const newer = body({ itemTypes: { t: '{"a":1}' }, itemTypesAt: { t: T1 } });
    expect(mergeVaultBodies(older, newer).itemTypes).toEqual({ t: '{"a":1}' });
    expect(mergeVaultBodies(newer, older).itemTypes).toEqual({ t: '{"a":1}' });
  });
});
