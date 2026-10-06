import { describe, expect, it } from "vitest";
import {
  type AccountItem,
  type LoginMethod,
  manualPassword,
  newPasswordMethod,
} from "./account.js";
import { bindCredential, unbindCredential } from "./credential-bind.js";
import {
  credentialField,
  credentialSearchText,
  credentialSubtitle,
} from "./credential-read.js";
import { splitAccount } from "./credential-split.js";
import {
  type CredentialItem,
  createCredential,
  resolveAccounts,
  unboundCredentials,
} from "./credential.js";
import { readItemField } from "./item-types.js";
import { type VaultItem, createItem, itemSubtitle } from "./model.js";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";
const T2 = "2026-01-03T00:00:00.000Z";

function account(id: string, name = "Billing", updatedAt = T0): AccountItem {
  const base = createItem("account", name);
  return { ...base, id, createdAt: T0, updatedAt, methods: [] };
}

const apiKey = (id: string, header = "X-Api-Key", key = "k1"): LoginMethod => ({
  id,
  type: "api-key",
  key,
  header,
});
const token = (id: string): LoginMethod => ({
  id,
  type: "token",
  token: "t1",
  expiresAt: "2027-01-31T00:00:00Z",
});
const password = (id: string, secret = "pw"): LoginMethod =>
  manualPassword(id, secret, T0);

function methodsOf(items: readonly VaultItem[], id: string): string[] {
  const found = resolveAccounts(items).find((item) => item.id === id);
  if (found?.kind !== "account") throw new Error("no account");
  return found.methods.map((method) => method.id);
}

describe("binding", () => {
  const unbound = createCredential(password("p1"), "My password", null, T0);

  it("binds a credential kept on its own as the account's last method", () => {
    const items = splitAccount(
      [unbound],
      { ...account("a"), methods: [apiKey("a:k")] },
      T1,
    );
    const outcome = bindCredential(items, "p1", "a", T2);
    if (!outcome.ok) throw new Error("refused");
    expect(methodsOf(outcome.items, "a")).toEqual(["a:k", "p1"]);
    expect(outcome.items.find((item) => item.id === "p1")?.name).toBe(
      "Billing · Password",
    );
  });

  it("refuses a missing credential, a missing or trashed account, a trashed credential", () => {
    const base = [unbound, account("a")];
    expect(bindCredential(base, "nope", "a", T1)).toEqual({
      ok: false,
      refusal: "missing-credential",
    });
    expect(bindCredential(base, "p1", "nope", T1)).toEqual({
      ok: false,
      refusal: "missing-account",
    });
    expect(
      bindCredential(
        [unbound, { ...account("a"), deletedAt: T1 }],
        "p1",
        "a",
        T2,
      ),
    ).toEqual({ ok: false, refusal: "missing-account" });
    expect(
      bindCredential(
        [{ ...unbound, deletedAt: T1 }, account("a")],
        "p1",
        "a",
        T2,
      ),
    ).toEqual({ ok: false, refusal: "trashed" });
  });

  it("refuses a password an earlier pepper sealed: it opens only on its own account", () => {
    const legacy: LoginMethod = {
      ...newPasswordMethod("x", T0),
      id: "p2",
      secret: "",
      sealed: {
        v: 2,
        kdf: { alg: "PBKDF2-SHA256", saltB64: "AA==", iterations: 1 },
        seal: { ivB64: "AA==", ctB64: "AA==" },
      },
    };
    const sealed = createCredential(legacy, "Old", "a", T0);
    expect(bindCredential([sealed, account("b")], "p2", "b", T1)).toEqual({
      ok: false,
      refusal: "legacy-seal",
    });
  });

  it("unbinds without losing a value, a name or a folder", () => {
    const items = splitAccount(
      [],
      { ...account("a"), folderId: "f", methods: [password("a:p")] },
      T1,
    );
    const next = unbindCredential(items, "a:p", T2);
    const freed = next.find(
      (item): item is CredentialItem => item.id === "a:p",
    );
    expect(freed).toMatchObject({
      accountId: null,
      name: "Billing · Password",
      folderId: "f",
      method: { secret: "pw" },
    });
    expect(methodsOf(next, "a")).toEqual([]);
    expect(unboundCredentials(next).map((c) => c.id)).toEqual(["a:p"]);
  });

  it("unbinding one that is not bound is no change", () => {
    expect(unbindCredential([unbound], "p1", T2)).toEqual([unbound]);
  });

  it("calls a credential of a trashed or purged account unbound, rewriting nothing", () => {
    const items = splitAccount(
      [],
      { ...account("a"), methods: [password("a:p")] },
      T1,
    );
    expect(unboundCredentials(items)).toEqual([]);
    const trashed = items.map((item) =>
      item.id === "a" ? { ...item, deletedAt: T2 } : item,
    );
    expect(unboundCredentials(trashed).map((c) => c.id)).toEqual(["a:p"]);
    const purged = items.filter((item) => item.id !== "a");
    expect(unboundCredentials(purged).map((c) => c.id)).toEqual(["a:p"]);
    expect(purged.find((item) => item.id === "a:p")).toMatchObject({
      accountId: "a",
    });
  });
});

describe("what a credential shows", () => {
  it("names its type and detail in the list, and never a value", () => {
    const key = createCredential(
      apiKey("k", "X-Api-Key", "SECRET-VALUE"),
      "K",
      "a",
      T0,
    );
    expect(itemSubtitle(key)).toBe("API key · X-Api-Key");
    expect(credentialSubtitle(key)).not.toContain("SECRET-VALUE");
    expect(credentialSearchText(key).join(" ")).not.toContain("SECRET-VALUE");
    const free = createCredential(token("t"), "T", null, T0);
    expect(credentialSubtitle(free)).toBe(
      "Token · until 2027-01-31 · not bound",
    );
  });

  it("reads the fields its type declares", () => {
    const key = createCredential(
      apiKey("k", "X-Api-Key", "VALUE"),
      "K",
      null,
      T0,
    );
    expect(credentialField(key, "apiKey")).toBe("VALUE");
    expect(credentialField(key, "header")).toBe("X-Api-Key");
    expect(credentialField(key, "other")).toBeUndefined();
    const empty = createCredential(
      apiKey("k2", "X-Api-Key", ""),
      "K",
      null,
      T0,
    );
    expect(credentialField(empty, "apiKey")).toBeUndefined();
    const pw = createCredential(newPasswordMethod("p", T0), "P", null, T0);
    expect(
      readItemField(pw, {
        id: "password",
        type: "concealed",
        label: "Password",
      }),
    ).toBeUndefined();
  });
});
