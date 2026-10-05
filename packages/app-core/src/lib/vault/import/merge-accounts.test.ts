import {
  type AccountItem,
  createItem,
  manualPassword,
  methodsOfType,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { mergeAccounts } from "./merge-accounts.js";

const AT = "2024-01-01T00:00:00.000Z";

function account(name: string, methods: AccountItem["methods"]): AccountItem {
  const item = createItem("account", name);
  item.username = "ada";
  item.methods = methods;
  return item;
}

describe("mergeAccounts", () => {
  it("adds the methods the existing account lacks", () => {
    const existing = account("Mail", [manualPassword("p1", "pw", AT)]);
    const incoming = account("Mail", [
      manualPassword("q1", "pw", AT),
      { id: "q2", type: "authenticator", secret: "JBSWY3DPEHPK3PXP" },
      { id: "q3", type: "api-key", key: "key-1", header: "X-Api-Key" },
    ]);
    const merged = mergeAccounts(existing, incoming);
    expect(merged.account.methods.map((m) => m.type)).toEqual([
      "password",
      "authenticator",
      "api-key",
    ]);
    expect(merged.added.map((m) => m.id)).toEqual(["q2", "q3"]);
    expect(merged.duplicates.map((m) => m.id)).toEqual(["q1"]);
    expect(merged.conflicts).toEqual([]);
  });

  it("treats the same id or the same secret as a duplicate, not a copy", () => {
    const existing = account("Mail", [
      manualPassword("p1", "pw", AT),
      { id: "a1", type: "authenticator", secret: "SEED" },
    ]);
    const incoming = account("Mail", [
      manualPassword("p1", "changed elsewhere", AT),
      { id: "other", type: "authenticator", secret: "SEED" },
    ]);
    const merged = mergeAccounts(existing, incoming);
    expect(merged.added).toEqual([]);
    expect(merged.duplicates).toHaveLength(2);
    expect(merged.account.methods).toEqual(existing.methods);
  });

  it("keeps the existing password and reports a different one as a conflict", () => {
    const existing = account("Mail", [manualPassword("p1", "kept", AT)]);
    const incoming = account("Mail", [manualPassword("q1", "other", AT)]);
    const merged = mergeAccounts(existing, incoming);
    expect(methodsOfType(merged.account, "password")).toHaveLength(1);
    expect(methodsOfType(merged.account, "password")[0]?.secret).toBe("kept");
    expect(merged.conflicts.map((m) => m.id)).toEqual(["q1"]);
    expect(merged.added).toEqual([]);
  });

  it("takes a password when the existing account holds none", () => {
    const existing = account("Mail", [
      { id: "a1", type: "authenticator", secret: "SEED" },
    ]);
    const incoming = account("Mail", [manualPassword("q1", "pw", AT)]);
    const merged = mergeAccounts(existing, incoming);
    expect(merged.added.map((m) => m.id)).toEqual(["q1"]);
  });

  it("adds a second authenticator with a different seed", () => {
    const existing = account("Mail", [
      { id: "a1", type: "authenticator", secret: "ONE" },
    ]);
    const incoming = account("Mail", [
      { id: "a2", type: "authenticator", secret: "TWO" },
    ]);
    const merged = mergeAccounts(existing, incoming);
    expect(methodsOfType(merged.account, "authenticator")).toHaveLength(2);
  });

  it("re-mints an id that collides with a different method", () => {
    const existing = account("Mail", [
      { id: "same", type: "authenticator", secret: "ONE" },
    ]);
    const incoming = account("Mail", [
      { id: "same", type: "api-key", key: "k", header: "" },
    ]);
    const merged = mergeAccounts(existing, incoming);
    const ids = merged.account.methods.map((m) => m.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe("same");
  });

  it("never reads a sealed password: a peppered one is compared by id only", () => {
    const peppered = {
      ...manualPassword("p1", "", AT),
      pepper: true,
    };
    const existing = account("Mail", [peppered]);
    const incoming = account("Mail", [manualPassword("q1", "", AT)]);
    const merged = mergeAccounts(existing, incoming);
    expect(merged.conflicts.map((m) => m.id)).toEqual(["q1"]);
  });
});
