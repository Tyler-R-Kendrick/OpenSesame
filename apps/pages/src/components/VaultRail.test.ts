import {
  foldersForKind,
  uniqueFolderKind,
} from "@opensesame/app-core/components/vault-rail-model.js";
import type { Folder, VaultItem } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";

const folders: Folder[] = [
  { id: "work", name: "Work", createdAt: "2026-01-01" },
  { id: "empty", name: "Empty", createdAt: "2026-01-01" },
];
// SAFETY: fixture constructed in this test matches the declared contract.
const items = [
  { kind: "account", deletedAt: null, folderId: "work" },
  { kind: "note", deletedAt: null, folderId: "work" },
  { kind: "account", deletedAt: "2026-01-02", folderId: "empty" },
] as VaultItem[];

describe("vault rail folders", () => {
  it("places a folder under each kind that has a live item in it", () => {
    expect(
      foldersForKind("account", items, folders).map((folder) => folder.id),
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

  it("infers account when that is the only live kind in the folder", () => {
    // SAFETY: fixture constructed in this test matches the declared contract.
    const onlyAccount = [
      { kind: "account", deletedAt: null, folderId: "work" },
      { kind: "card", deletedAt: "2026-01-02", folderId: "work" },
    ] as VaultItem[];
    // The rail names a kind only while that kind is installed.
    const installed = [
      { id: "account", segment: "accounts", label: "Account", order: 0 },
    ];
    expect(uniqueFolderKind(onlyAccount, "work", installed)).toBe("account");
    expect(uniqueFolderKind(onlyAccount, "work")).toBeNull();
  });
});
