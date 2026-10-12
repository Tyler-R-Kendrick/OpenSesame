import { describe, expect, it } from "vitest";
import {
  type AccountItem,
  type LoginMethod,
  manualPassword,
} from "./account.js";
import { extractEmbeddedMethods, splitAccount } from "./credential-split.js";
import {
  boundCredentialName,
  boundCredentials,
  createCredential,
  credentialTypeId,
  isCredentialTypeId,
  listedItems,
  loginMethodTypeOf,
  resolveAccounts,
} from "./credential.js";
import { itemTypeId } from "./item-types.js";
import { type VaultItem, createItem } from "./model.js";

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

describe("credential types", () => {
  it("names one item type per login method type, and reads them back", () => {
    expect(credentialTypeId("oauth")).toBe("oauth-client");
    expect(credentialTypeId("api-key")).toBe("api-key");
    expect(loginMethodTypeOf("oauth-client")).toBe("oauth");
    expect(loginMethodTypeOf("secret")).toBeUndefined();
    expect(isCredentialTypeId("token")).toBe(true);
    expect(isCredentialTypeId("account")).toBe(false);
  });

  it("is the type id of the credential item, so the registry gates it", () => {
    const credential = createCredential(apiKey("c1"), "Key", null, T0);
    expect(itemTypeId(credential)).toBe("api-key");
    expect(itemTypeId(createCredential(password("c2"), "P", null, T0))).toBe(
      "password",
    );
  });
});

describe("listedItems", () => {
  it("does not draw a bound password beside its account", () => {
    const items = splitAccount(
      [],
      { ...account("a"), methods: [password("a:p")] },
      T1,
    );
    expect(items.some((item) => item.kind === "credential")).toBe(true);
    expect(listedItems(items).map((item) => item.id)).toEqual(["a"]);
  });

  it("keeps an unbound password and a method removed into the trash", () => {
    const spare = createCredential(password("own"), "Spare", null, T0);
    const bound = splitAccount(
      [],
      { ...account("a"), methods: [password("a:p"), apiKey("a:k")] },
      T1,
    );
    const resolved = resolveAccounts(bound);
    const editing = resolved.find((item) => item.id === "a");
    if (editing?.kind !== "account") throw new Error("fixture");
    const removed = splitAccount(
      bound,
      {
        ...editing,
        methods: editing.methods.filter((method) => method.id !== "a:k"),
      },
      T2,
    );
    expect(listedItems([...removed, spare]).map((item) => item.id)).toEqual([
      "a",
      "a:k",
      "own",
    ]);
  });
});

describe("splitAccount and resolveAccounts", () => {
  it("keeps methods as credentials bound to the account, in order", () => {
    const methods = [password("a:p"), apiKey("a:k"), token("a:t")];
    const items = splitAccount([], { ...account("a"), methods }, T1);
    const raw = items.find((item) => item.id === "a");
    expect(raw?.kind === "account" && raw.methods).toEqual([]);
    expect(boundCredentials(items, "a").map((c) => c.id)).toEqual([
      "a:p",
      "a:k",
      "a:t",
    ]);
    expect(methodsOf(items, "a")).toEqual(["a:p", "a:k", "a:t"]);
    expect(
      items.filter((item) => item.kind === "credential").map((c) => c.name),
    ).toEqual(["Billing · Password", "Billing · API key", "Billing · Token"]);
  });

  it("numbers the credentials of a type an account holds several of", () => {
    const methods = [apiKey("a:1", "X-A"), apiKey("a:2", "X-B")];
    const [first, second] = methods;
    if (!first || !second) throw new Error("fixture");
    expect(boundCredentialName("Billing", first, methods)).toBe(
      "Billing · API key 1",
    );
    expect(boundCredentialName("Billing", second, methods)).toBe(
      "Billing · API key 2",
    );
    expect(boundCredentialName("", first, [first])).toBe("API key");
  });

  it("puts a removed method in the trash, restorable, and leaves the others", () => {
    const methods = [password("a:p"), apiKey("a:k")];
    const first = splitAccount([], { ...account("a"), methods }, T1);
    const resolved = resolveAccounts(first);
    const editing = resolved.find((item) => item.id === "a");
    if (editing?.kind !== "account") throw new Error("fixture");
    const next = splitAccount(
      first,
      { ...editing, methods: editing.methods.filter((m) => m.id !== "a:k") },
      T2,
    );
    const gone = next.find((item) => item.id === "a:k");
    expect(gone).toMatchObject({ deletedAt: T2, accountId: "a" });
    expect(methodsOf(next, "a")).toEqual(["a:p"]);
  });

  it("removing the last method leaves an account with none", () => {
    const first = splitAccount(
      [],
      { ...account("a"), methods: [password("a:p")] },
      T1,
    );
    const next = splitAccount(first, { ...account("a"), methods: [] }, T2);
    expect(methodsOf(next, "a")).toEqual([]);
    expect(next.find((item) => item.id === "a:p")?.deletedAt).toBe(T2);
  });

  it("does not touch a credential whose method did not change", () => {
    const methods = [password("a:p")];
    const first = splitAccount([], { ...account("a"), methods }, T1);
    const again = splitAccount(first, { ...account("a"), methods }, T2);
    expect(again.find((item) => item.id === "a:p")).toBe(
      first.find((item) => item.id === "a:p"),
    );
  });

  it("follows the account's name and folder", () => {
    const first = splitAccount(
      [],
      { ...account("a"), methods: [password("a:p")] },
      T1,
    );
    const next = splitAccount(
      first,
      {
        ...account("a", "Renamed"),
        folderId: "f",
        methods: [password("a:p")],
      },
      T2,
    );
    expect(next.find((item) => item.id === "a:p")).toMatchObject({
      name: "Renamed · Password",
      folderId: "f",
      updatedAt: T2,
    });
  });

  it("carries a trashed account's state to its credentials", () => {
    const first = splitAccount(
      [],
      { ...account("a"), methods: [password("a:p")] },
      T1,
    );
    const next = splitAccount(
      first,
      { ...account("a"), deletedAt: T2, methods: [password("a:p")] },
      T2,
    );
    expect(next.find((item) => item.id === "a:p")?.deletedAt).toBe(T2);
  });

  it("memoizes a resolved list and never mutates its input", () => {
    const items = splitAccount(
      [],
      { ...account("a"), methods: [password("a:p")] },
      T1,
    );
    const frozen = JSON.stringify(items);
    expect(resolveAccounts(items)).toBe(resolveAccounts(items));
    expect(JSON.stringify(items)).toBe(frozen);
  });

  it("reads an account whose credential was trashed as without it", () => {
    const items = splitAccount(
      [],
      { ...account("a"), methods: [password("a:p"), token("a:t")] },
      T1,
    ).map((item) => (item.id === "a:t" ? { ...item, deletedAt: T2 } : item));
    expect(methodsOf(items, "a")).toEqual(["a:p"]);
  });
});

describe("extractEmbeddedMethods", () => {
  it("moves every method of an account into a credential with its id and times", () => {
    const embedded: AccountItem = {
      ...account("a", "Billing", T1),
      methods: [password("a:password"), apiKey("a:key")],
    };
    const out = extractEmbeddedMethods([embedded]);
    expect(out.map((item) => item.id)).toEqual(["a", "a:password", "a:key"]);
    expect(out[0]?.kind === "account" && out[0].methods).toEqual([]);
    expect(out[1]).toMatchObject({
      kind: "credential",
      accountId: "a",
      order: 0,
      createdAt: T0,
      updatedAt: T1,
    });
  });

  it("is idempotent, and is the same on every device", () => {
    const embedded: AccountItem = {
      ...account("a", "Billing", T1),
      methods: [password("a:password"), token("a:t")],
    };
    const once = extractEmbeddedMethods([embedded]);
    expect(extractEmbeddedMethods(once)).toEqual(once);
    expect(extractEmbeddedMethods([structuredClone(embedded)])).toEqual(once);
  });

  it("keeps a credential that changed after the account did", () => {
    const stale: AccountItem = {
      ...account("a", "Billing", T0),
      methods: [password("a:password", "old")],
    };
    const fresher = {
      ...createCredential(password("a:password", "new"), "x", "a", T0),
      updatedAt: T2,
    };
    const out = extractEmbeddedMethods([stale, fresher]);
    const kept = out.find((item) => item.id === "a:password");
    expect(kept?.kind === "credential" && kept.method).toMatchObject({
      secret: "new",
    });
  });

  it("takes an embedded method over an older credential", () => {
    const stale = createCredential(password("a:password", "old"), "x", "a", T0);
    const fresh: AccountItem = {
      ...account("a", "Billing", T2),
      methods: [password("a:password", "new")],
    };
    const out = extractEmbeddedMethods([stale, fresh]);
    const kept = out.find((item) => item.id === "a:password");
    expect(kept?.kind === "credential" && kept.method).toMatchObject({
      secret: "new",
    });
  });

  it("leaves a list with nothing embedded as it is", () => {
    const items = [account("a"), createCredential(password("p"), "P", null)];
    expect(extractEmbeddedMethods(items)).toEqual(items);
  });
});
