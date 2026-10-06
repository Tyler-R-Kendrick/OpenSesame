import {
  type VaultItem,
  createItem,
  itemTypeRegistry,
} from "@opensesame/vault-core";
import { definitionFields } from "@opensesame/vault-item-types";
import { describe, expect, it } from "vitest";
import { pepperedAccount } from "../../../account.test-support.js";
import { VISIBLE_LIMITS, readVisibleItemsBody } from "./visible-items-shape.js";
import {
  isShareable,
  pickRows,
  shareItem,
  shareableItems,
} from "./visible-items-share.js";
import {
  HIDDEN,
  account,
  dressed,
  items,
  secret,
} from "./visible-items.fixture.js";

describe("what is eligible, and what is never copied", () => {
  it("offers accounts, notes, secrets and cards, by name and kind, never a secret", () => {
    const rows = pickRows(items());
    expect(rows.map((row) => row.label)).toEqual([
      "Netflix",
      "Hidden Bank",
      "Gym code",
      "Wi-Fi",
      "Visa",
    ]);
    expect(rows.map((row) => row.detail)).toEqual([
      "Account",
      "Account",
      "Secure note",
      "Secret",
      "Card",
    ]);
    expect(JSON.stringify(rows)).not.toContain(HIDDEN);
    expect(JSON.stringify(rows)).not.toContain("pw-Netflix");
  });

  it("never offers passkeys, certificates, drops, trashed or retired items", () => {
    const trashed = {
      ...account("Trashed"),
      deletedAt: new Date().toISOString(),
    };
    const retired = account("Retired", { retiredAt: new Date().toISOString() });
    const list: VaultItem[] = [
      createItem("passkey", "Passkey"),
      createItem("certificate", "Cert"),
      createItem("drop", "Drop"),
      trashed,
      retired,
      account("Kept"),
    ];
    expect(shareableItems(list).map((item) => item.name)).toEqual(["Kept"]);
    for (const item of list.slice(0, 5)) {
      expect(isShareable(item)).toBe(false);
      expect(shareItem(item)).toBeNull();
    }
  });

  it("leaves out a seed, history, links, folder, files and grants, by naming what it keeps", () => {
    const copy = shareItem(dressed());
    if (!copy) throw new Error("no copy");
    const text = JSON.stringify(copy);
    for (const left of [
      "JBSWY3DPEXAMPLESEED",
      "folder-secret-id",
      "reset-mail-id",
      "superseded-id",
      "old-retired",
      "old-history-password",
      "file-part-key",
      "scan.pdf",
    ]) {
      expect(text).not.toContain(left);
    }
    for (const key of [
      "totp",
      "folderId",
      "resetEmailId",
      "supersededById",
      "retiredAt",
      "reenrollState",
      "history",
      "attachments",
      "id",
      "deletedAt",
    ]) {
      expect(Object.keys(copy)).not.toContain(key);
    }
    // What makes it look lived in is kept.
    expect(copy).toMatchObject({
      kind: "login",
      name: "Bank",
      username: "bank@example.test",
      password: "pw-Bank",
      favorite: true,
      notes: "notes of Bank",
      uris: [{ uri: "https://bank.example.test", match: "host" }],
      fields: [{ name: "Branch", value: "Downtown", hidden: false }],
    });
    // A concealed custom field (a PIN, a security answer, a seed) is left behind.
    expect(JSON.stringify(copy)).not.toContain("4321");
    expect(JSON.stringify(copy)).not.toContain("PIN");
  });

  it("copies an account with a pepper slot without its password, and nothing sealed", async () => {
    const peppered = pepperedAccount("Vault Bank", "sealed-pw-77", "-2");
    const copy = shareItem(peppered);
    expect(copy).toMatchObject({
      kind: "login",
      name: "Vault Bank",
      password: "",
    });
    const text = JSON.stringify(copy);
    for (const left of ["sealed-pw-77", "pepperAt", "ciphertext", "kdf"]) {
      expect(text).not.toContain(left);
    }
  });

  it("leaves a secret's grants to agents behind", () => {
    const copy = shareItem(secret("Wi-Fi"));
    expect(copy).toMatchObject({ kind: "secret", value: "s-value" });
    const text = JSON.stringify(copy);
    for (const left of ["agent-7", "conn-9", "ceiling", "grantees"]) {
      expect(text).not.toContain(left);
    }
  });

  it("does not offer a typed item that this device does not know, or a custom one", () => {
    const unknown: VaultItem = {
      ...createItem("note", "Strange"),
      kind: "typed",
      typeId: "no-such-type",
      values: { a: "b" },
    };
    expect(isShareable(unknown)).toBe(false);
    const file: VaultItem = {
      ...createItem("note", "A file"),
      kind: "typed",
      typeId: "file",
      values: {},
    };
    expect(isShareable(file)).toBe(false);
  });

  it("omits malformed persisted typed values without throwing", () => {
    const candidate = itemTypeRegistry()
      .list()
      .find(({ definition, source }) => {
        if (source !== "builtin" || definitionFields(definition).length === 0)
          return false;
        return isShareable({
          ...createItem("note", "Typed"),
          kind: "typed",
          typeId: definition.metadata.id,
          values: {},
        });
      });
    if (!candidate) throw new Error("No shareable built-in typed fixture");
    const field = definitionFields(candidate.definition)[0];
    if (!field) throw new Error("Typed fixture has no field");
    const item: VaultItem = {
      ...createItem("note", "Typed"),
      kind: "typed",
      typeId: candidate.definition.metadata.id,
      values: {},
    };
    for (const invalid of [null, true, 42]) {
      Object.assign(item.values, { [field.id]: invalid });
      const copy = shareItem(item);
      expect(copy?.kind).toBe("typed");
      if (copy?.kind !== "typed") throw new Error("Typed copy was refused");
      expect(copy.values[field.id]).toBeUndefined();
    }
  });

  it("collapses a name to one line and cuts what is too long, so a copy always reads back", () => {
    const long = account("x".repeat(300), {
      notes: "n".repeat(10_000),
      password: "p".repeat(2000),
      createdAt: "not a date",
      passwordChangedAt: "",
    });
    const copy = shareItem({ ...long, name: `a\tb\n${"x".repeat(300)}` });
    if (!copy) throw new Error("no copy");
    expect(copy.name.length).toBeLessThanOrEqual(VISIBLE_LIMITS.name);
    expect(copy.name.startsWith("a b x")).toBe(true);
    expect(copy.notes).toHaveLength(VISIBLE_LIMITS.notes);
    expect(readVisibleItemsBody({ v: 1, items: [copy] })).not.toBeNull();
  });
});
