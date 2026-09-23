import { describe, expect, it } from "vitest";
import { type Folder, createItem } from "./model.js";
import { buildRows } from "./tree-rows.js";

function login(name: string, folderId?: string) {
  const item = createItem("login", name);
  return folderId ? { ...item, folderId } : item;
}

const at = "2026-09-23T00:00:00.000Z";
const work: Folder = { id: "f1", name: "Work", createdAt: at };
const home: Folder = { id: "f2", name: "Work", createdAt: at };

describe("buildRows", () => {
  it("lists folders with their items beneath, then root items", () => {
    const rows = buildRows(
      [login("mail", "f1"), login("bank")],
      [work],
      new Set(),
      "",
    );
    expect(rows.map((row) => [row.type, row.path])).toEqual([
      ["dir", "Work/"],
      ["item", "Work/mail.login"],
      ["item", "bank.login"],
    ]);
  });

  it("gives two folders with one name distinct paths", () => {
    const rows = buildRows([], [work, home], new Set(), "");
    expect(rows.map((row) => row.path)).toEqual(["Work/", "Work (2)/"]);
  });

  it("keeps a collapsed folder's items out until it is expanded", () => {
    const rows = buildRows(
      [login("mail", "f1")],
      [work],
      new Set(["Work/"]),
      "",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "dir", count: 1, expanded: false });
  });

  it("a search opens matching folders and drops everything else", () => {
    const rows = buildRows(
      [login("mail", "f1"), login("chat", "f1"), login("bank")],
      [work],
      new Set(["Work/"]),
      "mail",
    );
    expect(rows.map((row) => row.path)).toEqual(["Work/", "Work/mail.login"]);
  });

  it("a search that names a folder keeps the folder whole", () => {
    const rows = buildRows(
      [login("mail", "f1"), login("chat", "f1")],
      [work],
      new Set(),
      "work",
    );
    expect(rows.map((row) => row.path)).toEqual([
      "Work/",
      "Work/mail.login",
      "Work/chat.login",
    ]);
  });
});
