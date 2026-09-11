import { describe, expect, it } from "vitest";
import type { Folder, VaultItem } from "../lib/vault/model.js";
import { foldersForKind, uniqueFolderKind } from "./VaultRail.js";

const folders: Folder[] = [
  { id: "work", name: "Work", createdAt: "2026-01-01" },
  { id: "empty", name: "Empty", createdAt: "2026-01-01" },
];
const items = [
  { kind: "login", deletedAt: null, folderId: "work" },
  { kind: "note", deletedAt: null, folderId: "work" },
  { kind: "login", deletedAt: "2026-01-02", folderId: "empty" },
] as VaultItem[];

describe("vault rail folders", () => {
  it("places a folder under each kind that has a live item in it", () => {
    expect(
      foldersForKind("login", items, folders).map((folder) => folder.id),
    ).toEqual(["work"]);
    expect(
      foldersForKind("note", items, folders).map((folder) => folder.id),
    ).toEqual(["work"]);
    expect(foldersForKind("card", items, folders)).toEqual([]);
  });

  it("does not infer a kind when a folder holds more than one", () => {
    expect(uniqueFolderKind(items, "work")).toBeNull();
    expect(uniqueFolderKind(items, "empty")).toBeNull();
  });

  it("infers login when that is the only live kind in the folder", () => {
    const onlyLogin = [
      { kind: "login", deletedAt: null, folderId: "work" },
      { kind: "card", deletedAt: "2026-01-02", folderId: "work" },
    ] as VaultItem[];
    expect(uniqueFolderKind(onlyLogin, "work")).toBe("login");
  });
});
