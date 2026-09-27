import {
  type Folder,
  type VaultBody,
  type VaultItem,
  createItem,
  emptyBody,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { applyManifestPlan, dropSample } from "./body-edits.js";
import { SAMPLE_FOLDER_NAME, buildSample } from "./sample.js";

function folder(name: string): Folder {
  return { id: crypto.randomUUID(), name, createdAt: "2026-01-01T00:00:00Z" };
}

function bodyWith(items: VaultItem[], folders: Folder[]): VaultBody {
  return { ...emptyBody(), items, folders };
}

describe("dropSample", () => {
  it("removes every sample item and the folder only they sat in", () => {
    const samples = folder(SAMPLE_FOLDER_NAME);
    const work = folder("Work");
    const real = { ...createItem("login", "Real"), folderId: work.id };
    const loose = createItem("secret", "Loose");
    const body = bodyWith(
      [real, ...buildSample(samples.id), loose],
      [work, samples],
    );

    dropSample(body);

    expect(body.items.map((item) => item.name)).toEqual(["Real", "Loose"]);
    expect(body.items).toContain(real);
    expect(body.items).toContain(loose);
    expect(body.folders).toEqual([work]);
    // Tombstoned, so a merge with another device's copy cannot revive them.
    expect(Object.keys(body.tombstones?.items ?? {})).toHaveLength(7);
    expect(Object.keys(body.tombstones?.folders ?? {})).toEqual([samples.id]);
  });

  it("keeps a folder a real item also sits in, and never moves that item", () => {
    const samples = folder(SAMPLE_FOLDER_NAME);
    const mine = { ...createItem("note", "Mine"), folderId: samples.id };
    const body = bodyWith([...buildSample(samples.id), mine], [samples]);

    dropSample(body);

    expect(body.items).toEqual([mine]);
    expect(body.folders).toEqual([samples]);
    expect(body.tombstones?.folders).toBeUndefined();
  });

  it("takes trashed sample items too, and leaves trashed real items", () => {
    const trashedSample = {
      ...createItem("login", "Old sample"),
      sample: true,
      deletedAt: "2026-02-01T00:00:00Z",
    };
    const trashedReal = {
      ...createItem("login", "Old real"),
      deletedAt: "2026-02-01T00:00:00Z",
    };
    const body = bodyWith([trashedSample, trashedReal], []);

    dropSample(body);

    expect(body.items).toEqual([trashedReal]);
  });

  it("changes nothing when the vault holds no sample data", () => {
    const real = createItem("login", "Real");
    const body = bodyWith([real], [folder(SAMPLE_FOLDER_NAME)]);
    const before = structuredClone(body);

    dropSample(body);

    expect(body).toEqual(before);
  });
});

describe("applyManifestPlan", () => {
  it("adds, rewrites in place with a fresh stamp, and adds folders once", () => {
    const current = {
      ...createItem("login", "Kept"),
      updatedAt: "2020-01-01T00:00:00Z",
    };
    const added = createItem("login", "Added");
    const made = folder("Dev");
    const body = bodyWith([current], []);

    applyManifestPlan(body, {
      adds: [added],
      updates: [{ ...current, notes: "from manifest" }],
      newFolders: [made],
    });

    expect(body.items.map((item) => item.name)).toEqual(["Kept", "Added"]);
    expect(body.items[0]?.notes).toBe("from manifest");
    expect(body.items[0]?.updatedAt).not.toBe("2020-01-01T00:00:00Z");
    expect(body.folders).toEqual([made]);
  });
});
