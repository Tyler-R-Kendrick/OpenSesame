import { type Folder, createItem, emptyBody } from "@opensesame/vault-core";
import type { VaultBody, VaultItem } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { retireLegacySample } from "./body-edits.js";

const folder = (id: string, name: string): Folder => ({
  id,
  name,
  createdAt: "2026-01-01T00:00:00Z",
});

/** An item as the retired sample-data feature wrote it: flagged, untyped. */
function legacy(name: string, folderId: string | null): VaultItem {
  // SAFETY: sample is the retired flag this fixture preserves on an otherwise checked login item.
  return {
    ...createItem("account", name),
    folderId,
    sample: true,
  } as VaultItem;
}

function bodyWith(items: VaultItem[], folders: Folder[]): VaultBody {
  return { ...emptyBody(), items, folders };
}

describe("retireLegacySample", () => {
  it("removes every flagged item and the folder only they sat in, and tombstones both", () => {
    const real = { ...createItem("account", "Payroll"), folderId: "work" };
    const body = bodyWith(
      [real, legacy("GitHub", "demo"), legacy("Bank", "demo")],
      [folder("work", "Work"), folder("demo", "Sample data")],
    );
    retireLegacySample(body);
    expect(body.items).toEqual([real]);
    expect(body.folders.map((f) => f.name)).toEqual(["Work"]);
    expect(JSON.stringify(body.tombstones)).toContain("demo");
  });

  it("takes a trashed flagged item too, and leaves a trashed real one", () => {
    const trashedReal = {
      ...createItem("note", "Old"),
      deletedAt: "2026-02-01T00:00:00Z",
    };
    const trashedDemo = {
      ...legacy("Demo", null),
      deletedAt: "2026-02-01T00:00:00Z",
    };
    const body = bodyWith([trashedReal, trashedDemo], []);
    retireLegacySample(body);
    expect(body.items).toEqual([trashedReal]);
  });

  it("keeps a folder a real item also sits in, and moves nothing", () => {
    const real = { ...createItem("account", "Mine"), folderId: "shared" };
    const body = bodyWith(
      [real, legacy("Demo", "shared")],
      [folder("shared", "Shared")],
    );
    retireLegacySample(body);
    expect(body.items).toEqual([real]);
    expect(body.folders.map((f) => f.id)).toEqual(["shared"]);
  });

  it("changes nothing when the vault holds none", () => {
    const real = createItem("account", "Mine");
    const body = bodyWith([real], []);
    const before = JSON.stringify(body);
    retireLegacySample(body);
    expect(JSON.stringify(body)).toBe(before);
  });
});
