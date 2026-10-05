import { describe, expect, it } from "vitest";
import {
  type LegacyLoginItem,
  accountPlainPassword,
  accountTotp,
  isLegacyLogin,
  methodsOfType,
  migrateLegacyLogin,
  needsPepper,
  normalizeLegacyItems,
  passwordMethod,
  plainPassword,
} from "./account.js";
import { createItem } from "./model.js";

function legacy(overrides: Partial<LegacyLoginItem> = {}): LegacyLoginItem {
  return {
    id: "item-1",
    kind: "login",
    name: "Mail",
    folderId: null,
    favorite: true,
    notes: "n",
    fields: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
    deletedAt: null,
    username: "ada",
    password: "hunter2",
    totp: "JBSWY3DPEHPK3PXP",
    uris: [{ id: "u1", uri: "https://mail.example.com", match: "domain" }],
    passwordChangedAt: "2026-01-15T00:00:00.000Z",
    resetEmailId: "email-1",
    ...overrides,
  };
}

describe("migrateLegacyLogin", () => {
  it("keeps the identity, sites and metadata and turns secrets into methods", () => {
    const account = migrateLegacyLogin(legacy());
    expect(account).toMatchObject({
      kind: "account",
      id: "item-1",
      name: "Mail",
      username: "ada",
      favorite: true,
      resetEmailId: "email-1",
    });
    expect(account.uris).toHaveLength(1);
    expect("password" in account).toBe(false);
    expect("totp" in account).toBe(false);
    expect("passwordChangedAt" in account).toBe(false);
    expect(passwordMethod(account)).toMatchObject({
      generator: { id: "manual" },
      pepper: false,
      secret: "hunter2",
      changedAt: "2026-01-15T00:00:00.000Z",
    });
    expect(accountTotp(account)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("derives method ids from the item id, so two devices agree", () => {
    const a = migrateLegacyLogin(legacy());
    const b = migrateLegacyLogin(legacy());
    expect(a.methods.map((m) => m.id)).toEqual(b.methods.map((m) => m.id));
  });

  it("keeps an empty password method for a login with nothing in it", () => {
    const account = migrateLegacyLogin(legacy({ password: "", totp: "" }));
    expect(account.methods).toHaveLength(1);
    expect(passwordMethod(account)?.secret).toBe("");
  });

  it("drops the empty password but keeps the authenticator", () => {
    const account = migrateLegacyLogin(legacy({ password: "" }));
    expect(methodsOfType(account, "password")).toHaveLength(0);
    expect(methodsOfType(account, "authenticator")).toHaveLength(1);
  });

  it("carries retirement and re-enrolment through", () => {
    const account = migrateLegacyLogin(
      legacy({
        retiredAt: "2026-03-01T00:00:00.000Z",
        supersededById: "item-2",
        reenrollState: "old-retired",
      }),
    );
    expect(account).toMatchObject({
      retiredAt: "2026-03-01T00:00:00.000Z",
      supersededById: "item-2",
      reenrollState: "old-retired",
    });
  });
});

describe("normalizeLegacyItems", () => {
  it("migrates logins, leaves other kinds alone, and is idempotent", () => {
    const note = createItem("note", "N");
    const once = normalizeLegacyItems([legacy(), note]);
    expect(once.map((item) => (item as { kind: string }).kind)).toEqual([
      "account",
      "note",
    ]);
    expect(once[1]).toBe(note);
    expect(normalizeLegacyItems(once)).toEqual(once);
    expect(isLegacyLogin(once[0])).toBe(false);
  });
});

describe("a new account", () => {
  it("starts with one empty password method that is not peppered", () => {
    const account = createItem("account", "Site");
    if (account.kind !== "account") throw new Error("expected account");
    expect(account.methods).toHaveLength(1);
    expect(account.methods[0]).toMatchObject({
      type: "password",
      generator: { id: "rules" },
      pepper: false,
      secret: "",
      changedAt: account.createdAt,
    });
  });
});

describe("password helpers", () => {
  it("hands out a plain password only when nothing needs asking", () => {
    const account = createItem("account", "A");
    if (account.kind !== "account") throw new Error("expected account");
    const method = passwordMethod(account);
    if (!method) throw new Error("expected a password method");
    method.secret = "s3cret";
    expect(plainPassword(method)).toBe("s3cret");
    expect(needsPepper(method)).toBe(false);
    expect(accountPlainPassword(account)).toBe("s3cret");

    method.pepper = true;
    method.secret = "";
    expect(plainPassword(method)).toBeNull();
    expect(needsPepper(method)).toBe(true);
    expect(accountPlainPassword(account)).toBe("");
  });

  it("treats sphinx as always asking", () => {
    const account = createItem("account", "A");
    if (account.kind !== "account") throw new Error("expected account");
    const method = passwordMethod(account);
    if (!method) throw new Error("expected a password method");
    method.generator = {
      id: "sphinx",
      rules: {
        length: 20,
        lower: true,
        upper: true,
        digits: true,
        symbols: true,
        avoidAmbiguous: false,
        minDigits: 0,
        minSymbols: 0,
      },
      realm: "example.com",
      counter: 0,
      oprfKeyB64: "AA==",
    };
    expect(needsPepper(method)).toBe(true);
    expect(plainPassword(method)).toBeNull();
  });
});
