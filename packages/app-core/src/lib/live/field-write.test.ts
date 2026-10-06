/** Authorized edits land on the vault item the catalog shared. */
import {
  type AccountItem,
  type VaultItem,
  accountTotp,
  createItem,
  passwordMethod,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import {
  derivedAccount,
  legacySealedAccount,
  pepperedAccount,
  plainAccount,
  producedPassword,
} from "../account.test-support.js";
import {
  PasswordWriteRefused,
  assignField,
  vaultWrite,
} from "./field-write.js";

describe("assignField", () => {
  it("replaces an account password and stamps when it changed", async () => {
    const item = plainAccount("GitHub", "hunter2", { username: "octo" });
    const next = await assignField(item, "password", "rotated");
    expect(producedPassword(item)).toBe("hunter2");
    expect(next?.kind).toBe("account");
    if (next?.kind !== "account") return;
    expect(producedPassword(next)).toBe("rotated");
    expect(next.username).toBe("octo");
    expect(passwordMethod(next)?.changedAt).toBe(next.updatedAt);
    expect(await assignField(item, "nope", "x")).toBeNull();
  });

  it("sets an account's authenticator seed, adding the method when absent", async () => {
    const item = plainAccount("GitHub", "hunter2");
    const first = await assignField(item, "totp", "JBSWY3DPEHPK3PXP");
    if (first?.kind !== "account") throw new Error("fixture");
    expect(accountTotp(first)).toBe("JBSWY3DPEHPK3PXP");
    expect(first.methods).toHaveLength(2);
    const second = await assignField(first, "totp", "KRSXG5CTMVRXEZLU");
    if (second?.kind !== "account") throw new Error("fixture");
    expect(accountTotp(second)).toBe("KRSXG5CTMVRXEZLU");
    expect(second.methods).toHaveLength(2);
  });

  it("writes a stored password into a method with a pepper slot, and keeps the slot", async () => {
    const item = pepperedAccount("GitHub", "old-secret", "-2");
    const next = await assignField(item, "password", "rotated");
    if (next?.kind !== "account") throw new Error("fixture");
    const method = passwordMethod(next);
    expect(method).toMatchObject({
      secret: "rotated",
      pepper: true,
      pepperAt: "-2",
    });
  });

  it("refuses to write over what an older version sealed", async () => {
    const item = await legacySealedAccount("GitHub", "old-secret", "pepper");
    await expect(assignField(item, "password", "plain")).rejects.toBeInstanceOf(
      PasswordWriteRefused,
    );
    expect(JSON.stringify(item)).not.toContain("plain");
  });

  it("refuses to write a password a derived method computes", async () => {
    await expect(
      assignField(derivedAccount("Bank"), "password", "x"),
    ).rejects.toMatchObject({ reason: "computed" });
  });

  it("refuses to write a computed Sphinx password at all", async () => {
    const item: AccountItem = plainAccount("GitHub", "x");
    const method = passwordMethod(item);
    if (method === undefined) throw new Error("fixture");
    item.methods = [
      {
        ...method,
        pepper: true,
        generator: {
          id: "sphinx",
          rules: {
            length: 20,
            lower: true,
            upper: true,
            digits: true,
            symbols: false,
            avoidAmbiguous: false,
            minDigits: 0,
            minSymbols: 0,
          },
          realm: "example.com",
          counter: 0,
          oprfKeyB64: "AAAA",
        },
        secret: "",
      },
    ];
    await expect(assignField(item, "password", "x")).rejects.toMatchObject({
      reason: "computed",
    });
  });

  it("replaces notes and a custom field, and refuses an unknown custom id", async () => {
    const item = createItem("account", "GitHub");
    item.notes = "old";
    item.fields = [{ id: "pin", name: "PIN", value: "0000", hidden: true }];
    const noted = await assignField(item, "notes", "new");
    expect(noted?.notes).toBe("new");
    const custom = await assignField(item, "custom:pin", "9999");
    expect(custom?.fields[0]?.value).toBe("9999");
    expect(item.fields[0]?.value).toBe("0000");
    expect(await assignField(item, "custom:missing", "1")).toBeNull();
  });

  it("replaces a secret's value and a typed string, and leaves other keys", async () => {
    const secret = createItem("secret", "API");
    secret.value = "sk-old";
    const rotated = await assignField(secret, "value", "sk-new");
    expect(rotated?.kind).toBe("secret");
    if (rotated?.kind === "secret") expect(rotated.value).toBe("sk-new");
    const note = createItem("note", "Widget");
    const typed = {
      ...note,
      kind: "typed" as const,
      typeId: "widget",
      values: { token: "abc" },
    };
    const saved = await assignField(typed, "token", "def");
    expect(saved?.kind).toBe("typed");
    if (saved?.kind === "typed") expect(saved.values.token).toBe("def");
    expect(await assignField(typed, "title", "nope")).toBeNull();
  });
});

describe("vaultWrite", () => {
  it("saves a shared password and refuses a field the catalog does not hold", async () => {
    const item = plainAccount("GitHub", "hunter2");
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
    expect(written?.kind).toBe("account");
    if (written?.kind === "account")
      expect(producedPassword(written)).toBe("rotated");
    expect(await write(item.id, "nope", "x")).toBe(false);
    expect(await write("other", "password", "x")).toBe(false);
    expect(saved).toHaveLength(1);
  });

  it("never saves a write to a password an older version sealed", async () => {
    const item = await legacySealedAccount("GitHub", "old-secret", "pepper");
    const saved: VaultItem[] = [];
    const write = vaultWrite(
      { scope: { kind: "vault" }, items: () => [item] },
      async (next) => {
        saved.push(next);
      },
    );
    expect(await write(item.id, "password", "plain")).toBe(false);
    expect(saved).toEqual([]);
  });
});
