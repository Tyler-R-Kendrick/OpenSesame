/** Authorized edits land on the vault item the catalog shared. */
import { type VaultItem, createItem } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { assignField, vaultWrite } from "./field-write.js";

describe("assignField", () => {
  it("replaces a login password and stamps when it changed", () => {
    const item = createItem("login", "GitHub");
    item.username = "octo";
    item.password = "hunter2";
    const next = assignField(item, "password", "rotated");
    expect(item.password).toBe("hunter2");
    expect(next?.kind).toBe("login");
    if (next?.kind !== "login") return;
    expect(next.password).toBe("rotated");
    expect(next.username).toBe("octo");
    expect(next.passwordChangedAt).toBe(next.updatedAt);
    expect(assignField(item, "nope", "x")).toBeNull();
  });

  it("replaces notes and a custom field, and refuses an unknown custom id", () => {
    const item = createItem("login", "GitHub");
    item.notes = "old";
    item.fields = [{ id: "pin", name: "PIN", value: "0000", hidden: true }];
    const noted = assignField(item, "notes", "new");
    expect(noted?.notes).toBe("new");
    const custom = assignField(item, "custom:pin", "9999");
    expect(custom?.fields[0]?.value).toBe("9999");
    expect(item.fields[0]?.value).toBe("0000");
    expect(assignField(item, "custom:missing", "1")).toBeNull();
  });

  it("replaces a secret's value and a typed string, and leaves other keys", () => {
    const secret = createItem("secret", "API");
    secret.value = "sk-old";
    const rotated = assignField(secret, "value", "sk-new");
    expect(rotated?.kind).toBe("secret");
    if (rotated?.kind === "secret") expect(rotated.value).toBe("sk-new");
    const note = createItem("note", "Widget");
    const typed = {
      ...note,
      kind: "typed" as const,
      typeId: "widget",
      values: { token: "abc" },
    };
    const saved = assignField(typed, "token", "def");
    expect(saved?.kind).toBe("typed");
    if (saved?.kind === "typed") expect(saved.values.token).toBe("def");
    expect(assignField(typed, "title", "nope")).toBeNull();
  });
});

describe("vaultWrite", () => {
  it("saves a shared password and refuses a field the catalog does not hold", async () => {
    const item = createItem("login", "GitHub");
    item.password = "hunter2";
    const saved: VaultItem[] = [];
    const write = vaultWrite(
      { scope: { kind: "vault" }, items: () => [item] },
      async (next) => {
        saved.push(next);
      },
    );
    expect(await write(item.id, "password", "rotated")).toBe(true);
    expect(saved).toHaveLength(1);
    const written = saved[0];
    expect(written?.kind).toBe("login");
    if (written?.kind === "login") expect(written.password).toBe("rotated");
    expect(await write(item.id, "nope", "x")).toBe(false);
    expect(await write("other", "password", "x")).toBe(false);
    expect(saved).toHaveLength(1);
  });
});
