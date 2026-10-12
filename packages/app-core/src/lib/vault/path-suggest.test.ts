import type { Folder } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import {
  type TypeChoice,
  exactFolder,
  exactType,
  folderKey,
  folderQuery,
  folderSuggestions,
  newFolderKey,
  parseFolderKey,
  typeSuggestions,
} from "./path-suggest.js";

const folder = (id: string, name: string): Folder => ({
  id,
  name,
  createdAt: "2026-01-01",
});
const folders = [
  folder("w", "Work"),
  folder("wt", "Work/Taxes"),
  folder("p", "Personal"),
  folder("a", "Archive/Work"),
];
const types: TypeChoice[] = [
  { id: "login", extension: ".login", title: "Login" },
  { id: "secret", extension: ".secret", title: "Secret" },
  { id: "safe-deposit", extension: ".safe", title: "Bank locker" },
];

describe("folder suggestions", () => {
  it("offers the root first, then every folder by name, with nothing typed", () => {
    expect(folderSuggestions(folders, "").map((row) => row.label)).toEqual([
      "./",
      "Archive/Work/",
      "Personal/",
      "Work/",
      "Work/Taxes/",
    ]);
  });

  it("ranks a prefix before a segment before a substring, ties by name", () => {
    const matches = (query: string) =>
      folderSuggestions(folders, query)
        .filter((row) => !row.adding)
        .map((row) => row.label);
    expect(matches("wor")).toEqual(["Work/", "Work/Taxes/", "Archive/Work/"]);
    expect(matches("ax")).toEqual(["Work/Taxes/"]);
  });

  it("puts the row that makes a folder last, so the best match is what Enter takes", () => {
    const rows = folderSuggestions(folders, "wor");
    expect(rows.at(-1)).toEqual({
      key: newFolderKey("wor"),
      label: "wor/",
      adding: true,
    });
    expect(rows[0]?.adding).toBeUndefined();
  });

  it("reads ./ and / and a trailing slash as the path they name", () => {
    expect(folderQuery("./Work/")).toBe("Work");
    expect(folderQuery("/Work")).toBe("Work");
    expect(folderQuery("./")).toBe("");
    expect(folderQuery(".")).toBe("");
    expect(folderQuery("  Work/Taxes/ ")).toBe("Work/Taxes");
  });

  it("offers to make a folder only for a path a folder could have", () => {
    const labels = (query: string) =>
      folderSuggestions(folders, query).filter((row) => row.adding);
    expect(labels("Clients")).toEqual([
      { key: newFolderKey("Clients"), label: "Clients/", adding: true },
    ]);
    expect(labels("Work")).toEqual([]);
    expect(labels("work")).toEqual([]);
    expect(labels("../up")).toEqual([]);
    expect(labels("a//b")).toEqual([]);
  });

  it("finds the folder a typed path names exactly, case-insensitively", () => {
    expect(exactFolder(folders, "work/taxes")?.key).toBe(folderKey("wt"));
    expect(exactFolder(folders, "./")?.key).toBe("root");
    expect(exactFolder(folders, "Wor")).toBeUndefined();
  });

  it("round-trips its keys", () => {
    expect(parseFolderKey("root")).toEqual({ kind: "root" });
    expect(parseFolderKey(folderKey("wt"))).toEqual({
      kind: "folder",
      id: "wt",
    });
    expect(parseFolderKey(newFolderKey("a/b"))).toEqual({
      kind: "new",
      path: "a/b",
    });
    expect(parseFolderKey("nope")).toBeUndefined();
  });
});

describe("type suggestions", () => {
  it("lists every type with nothing typed", () => {
    expect(typeSuggestions(types, "").map((row) => row.key)).toEqual([
      "login",
      "secret",
      "safe-deposit",
    ]);
  });

  it("matches the extension with or without its dot, the id and the title", () => {
    expect(typeSuggestions(types, ".s").map((row) => row.key)).toEqual([
      "secret",
      "safe-deposit",
    ]);
    expect(typeSuggestions(types, "LOG").map((row) => row.key)).toEqual([
      "login",
    ]);
    expect(typeSuggestions(types, "locker").map((row) => row.key)).toEqual([
      "safe-deposit",
    ]);
    expect(typeSuggestions(types, "zzz")).toEqual([]);
  });

  it("never invents a type: only a listed extension is exact", () => {
    expect(exactType(types, ".login")?.key).toBe("login");
    expect(exactType(types, "SECRET")?.key).toBe("secret");
    expect(exactType(types, ".log")).toBeUndefined();
    expect(exactType(types, ".weird")).toBeUndefined();
  });
});
