import { describe, expect, it } from "vitest";
import { itemCreatePath, resolveItemPath, writeItem } from "./item-path.js";
import { createItem, emptyBody } from "./model.js";

const folder = { id: "work", name: "Work", createdAt: "2026-01-01" };
const nested = { id: "nested", name: "Work/test", createdAt: "2026-01-01" };

describe("editor item paths", () => {
  it.each([
    ["./test/login", null, "test", "login"],
    ["./test/login", "work", "Work/test", "login"],
    ["test/login", "work", "Work/test", "login"],
    ["/test/login", "work", "test", "login"],
    ["../login", "work", undefined, "login"],
    ["./sub/../login", "work", "Work", "login"],
    ["/login", "work", undefined, "login"],
    ["./测试/🔑", null, "测试", "🔑"],
    ["literal %2F", "work", "Work", "literal %2F"],
  ])("resolves %s from %s", (name, folderId, parent, leaf) => {
    const result = resolveItemPath(name, folderId, [folder, nested]);
    expect(result.name).toBe(leaf);
    expect(result.folder?.name).toBe(parent);
  });
  it.each([
    "../login",
    "/../login",
    "./test/",
    "./test/..",
    "./test/.",
    "./bad\u0000/name",
    "./bad\\path/name",
  ])("refuses malformed path %s", (name) => {
    expect(() => resolveItemPath(name, null, [])).toThrow();
  });
  it("reuses an existing folder and rejects a deleted selection", () => {
    expect(
      resolveItemPath("./test/login", "work", [folder, nested]).folder,
    ).toBe(nested);
    expect(() => resolveItemPath("login", "missing", [])).toThrow(
      "available folder",
    );
  });
  it("keeps folder context in typed and untyped New links", () => {
    expect(itemCreatePath(undefined, "a/b")).toBe("/vault/new?folder=a%2Fb");
    expect(itemCreatePath("login", "work")).toBe(
      "/vault/new/login?folder=work",
    );
  });
  it("writes an item and folder without mutating rollback snapshots", () => {
    const body = emptyBody();
    const oldItems = body.items;
    const oldFolders = body.folders;
    const item = { ...createItem("note", "login"), folderId: folder.id };
    writeItem(body, item, folder);
    expect(oldItems).toEqual([]);
    expect(oldFolders).toEqual([]);
    expect(body.items[0]?.folderId).toBe(folder.id);
    expect(body.folders).toEqual([folder]);
    const snapshot = body.items;
    writeItem(body, { ...item, name: "renamed" }, folder);
    expect(snapshot[0]?.name).toBe("login");
    expect(body.items).toHaveLength(1);
  });
  it("deduplicates independently staged folders at commit time", () => {
    const body = emptyBody();
    body.folders = [folder];
    const pending = { ...folder, id: "other" };
    writeItem(body, { ...createItem("note"), folderId: pending.id }, pending);
    expect(body.folders).toHaveLength(1);
    expect(body.items[0]?.folderId).toBe(folder.id);
  });
});
