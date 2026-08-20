import { describe, expect, it } from "vitest";
import type { Folder, LoginItem, VaultItem } from "../model.js";
import { createItem } from "../model.js";
import { defaultMergeOptions, planMerge } from "./merge.js";
import { type DraftItem, draftCard, draftLogin, draftNote } from "./types.js";
import { overlapCast } from "@opensesame/os-domain";

function login(
  name: string,
  username = "",
  folder: string | null = null,
): DraftItem {
  const draft = draftLogin(name);
  draft.username = username;
  draft.password = "hunter2";
  draft.folder = folder;
  return draft;
}

function existingLogin(name: string, username: string): LoginItem {
  const item = overlapCast(createItem("login", name));
  item.username = username;
  return item;
}

describe("planMerge", () => {
  it("gives every item and folder a fresh id", () => {
    const plan = planMerge(
      [login("GitHub", "ada", "Work")],
      [],
      [],
      defaultMergeOptions,
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.newFolders).toHaveLength(1);
    expect(plan.items[0]?.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(plan.items[0]?.folderId).toBe(plan.newFolders[0]?.id);
  });

  it("reuses a folder that already exists, matching case-insensitively", () => {
    const existing: Folder = {
      id: "f1",
      name: "Work",
      createdAt: "2024-01-01T00:00:00Z",
    };
    const plan = planMerge(
      [login("GitHub", "ada", "work")],
      [],
      [existing],
      defaultMergeOptions,
    );
    expect(plan.newFolders).toHaveLength(0);
    expect(plan.items[0]?.folderId).toBe("f1");
  });

  it("creates each source folder once across many items", () => {
    const drafts = [
      login("A", "a", "Work"),
      login("B", "b", "Work"),
      login("C", "c", "Home"),
    ];
    const plan = planMerge(drafts, [], [], defaultMergeOptions);
    expect(plan.newFolders.map((f) => f.name).sort()).toEqual(["Home", "Work"]);
  });

  it("drops source folders when asked not to keep them", () => {
    const plan = planMerge([login("GitHub", "ada", "Work")], [], [], {
      ...defaultMergeOptions,
      keepFolders: false,
    });
    expect(plan.newFolders).toHaveLength(0);
    expect(plan.items[0]?.folderId).toBeNull();
  });

  it("funnels everything into one folder and records where each came from", () => {
    const plan = planMerge([login("GitHub", "ada", "Work")], [], [], {
      ...defaultMergeOptions,
      intoFolder: "From LastPass",
    });
    expect(plan.newFolders.map((f) => f.name)).toEqual(["From LastPass"]);
    expect(plan.items[0]?.fields).toContainEqual(
      expect.objectContaining({ name: "Imported from folder", value: "Work" }),
    );
  });

  it("skips an item the vault already holds", () => {
    const existing: VaultItem[] = [existingLogin("GitHub", "ada")];
    const plan = planMerge(
      [login("GitHub", "ada")],
      existing,
      [],
      defaultMergeOptions,
    );
    expect(plan.items).toHaveLength(0);
    expect(plan.duplicates).toHaveLength(1);
  });

  it("treats a different username on the same site as a separate account", () => {
    const existing: VaultItem[] = [existingLogin("GitHub", "ada")];
    const plan = planMerge(
      [login("GitHub", "bob")],
      existing,
      [],
      defaultMergeOptions,
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.duplicates).toHaveLength(0);
  });

  it("reports duplicates but still imports them when told to", () => {
    const existing: VaultItem[] = [existingLogin("GitHub", "ada")];
    const plan = planMerge([login("GitHub", "ada")], existing, [], {
      ...defaultMergeOptions,
      skipDuplicates: false,
    });
    expect(plan.items).toHaveLength(1);
    expect(plan.duplicates).toHaveLength(1);
  });

  it("deduplicates within the file itself, not just against the vault", () => {
    const plan = planMerge(
      [login("GitHub", "ada"), login("GitHub", "ada")],
      [],
      [],
      defaultMergeOptions,
    );
    expect(plan.items).toHaveLength(1);
  });

  it("does not count a trashed item as a duplicate", () => {
    const trashed = existingLogin("GitHub", "ada");
    trashed.deletedAt = "2024-01-01T00:00:00Z";
    const plan = planMerge(
      [login("GitHub", "ada")],
      [trashed],
      [],
      defaultMergeOptions,
    );
    expect(plan.items).toHaveLength(1);
  });

  it("keeps source timestamps and falls back to now when there are none", () => {
    const draft = login("GitHub", "ada");
    draft.createdAt = "2020-03-04T05:06:07.000Z";
    const plan = planMerge(
      [draft, login("Other", "bob")],
      [],
      [],
      defaultMergeOptions,
    );
    expect(plan.items[0]?.createdAt).toBe("2020-03-04T05:06:07.000Z");
    expect(Date.parse(plan.items[1]?.createdAt ?? "")).toBeGreaterThan(0);
  });

  it("dates a password from the export rather than claiming it is brand new", () => {
    const draft = draftLogin("GitHub");
    draft.username = "ada";
    draft.passwordChangedAt = "2019-01-01T00:00:00.000Z";
    const plan = planMerge([draft], [], [], defaultMergeOptions);
    expect((overlapCast(plan.items[0])).passwordChangedAt).toBe(
      "2019-01-01T00:00:00.000Z",
    );
  });

  it("carries cards and notes across with their kind intact", () => {
    const card = draftCard("Visa");
    card.number = "4111111111111111";
    const note = draftNote("Door code");
    note.notes = "1234";
    const plan = planMerge([card, note], [], [], defaultMergeOptions);
    expect(plan.items.map((i) => i.kind)).toEqual(["card", "note"]);
  });

  it("names an item that arrived with no name", () => {
    const plan = planMerge([login("")], [], [], defaultMergeOptions);
    expect(plan.items[0]?.name).toBe("Untitled");
  });

  it("never marks an imported item as sample data", () => {
    const plan = planMerge(
      [login("GitHub", "ada")],
      [],
      [],
      defaultMergeOptions,
    );
    expect(plan.items[0]?.sample).toBeUndefined();
  });
});
