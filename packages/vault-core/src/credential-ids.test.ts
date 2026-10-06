import { describe, expect, it } from "vitest";
import {
  type AccountItem,
  type LoginMethod,
  manualPassword,
} from "./account.js";
import { extractEmbeddedMethods, splitAccount } from "./credential-split.js";
import {
  boundCredentials,
  resolveAccounts,
  unboundCredentials,
} from "./credential.js";
import { mergeVaultBodies } from "./merge.js";
import {
  type VaultBody,
  type VaultItem,
  createItem,
  emptyBody,
} from "./model.js";

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
const password = (id: string, secret = "pw"): LoginMethod =>
  manualPassword(id, secret, T0);

describe("ids a file chose", () => {
  it("keeps a method's own id when nothing else has it", () => {
    const items = splitAccount(
      [],
      { ...account("a"), methods: [apiKey("k")] },
      T1,
    );
    expect(items.map((item) => item.id)).toEqual(["a", "k"]);
  });

  it("scopes an id another item holds to the account, and never overwrites that item", () => {
    const note = { ...createItem("note", "A note"), id: "k" };
    const items = splitAccount(
      [note],
      { ...account("a"), methods: [apiKey("k")] },
      T1,
    );
    expect(items.find((item) => item.id === "k")?.kind).toBe("note");
    const credential = items.find((item) => item.id === "a:k");
    expect(credential).toMatchObject({ kind: "credential", accountId: "a" });
    expect(credential?.kind === "credential" && credential.method.id).toBe(
      "a:k",
    );
    // Written again, the same method lands on the same credential.
    const again = splitAccount(
      items,
      {
        ...account("a"),
        methods: [{ ...apiKey("k"), id: "a:k" }],
      },
      T2,
    );
    expect(again.filter((item) => item.kind === "credential")).toHaveLength(1);
  });

  it("does not take another account's credential", () => {
    const first = splitAccount(
      [],
      { ...account("a"), methods: [apiKey("k", "X-A", "first")] },
      T1,
    );
    const both = splitAccount(
      first,
      { ...account("b", "Other"), methods: [apiKey("k", "X-B", "second")] },
      T2,
    );
    expect(boundCredentials(both, "a").map((c) => c.method)).toMatchObject([
      { key: "first" },
    ]);
    expect(boundCredentials(both, "b").map((c) => c.method)).toMatchObject([
      { key: "second" },
    ]);
  });

  it("makes two methods of one file with the same id two credentials", () => {
    const items = splitAccount(
      [],
      {
        ...account("a"),
        methods: [apiKey("k", "X-1", "one"), apiKey("k", "X-2", "two")],
      },
      T1,
    );
    expect(boundCredentials(items, "a")).toHaveLength(2);
  });

  it("is deterministic: the same account extracts to the same credentials on every device", () => {
    const note = { ...createItem("note", "A note"), id: "k" };
    const embedded: AccountItem = {
      ...account("a", "Billing", T1),
      methods: [apiKey("k")],
    };
    expect(extractEmbeddedMethods([note, embedded])).toEqual(
      extractEmbeddedMethods([note, structuredClone(embedded)]),
    );
  });
});

describe("merging devices that disagree about an account's credentials", () => {
  const body = (items: VaultItem[], tombstones?: VaultBody["tombstones"]) => ({
    ...emptyBody(),
    items,
    ...(tombstones ? { tombstones } : undefined),
  });

  it("drops the credentials of an account purged elsewhere, extracted or not", () => {
    const stale = body(
      splitAccount([], { ...account("a"), methods: [password("a:p")] }, T0),
    );
    const purged = body([], { items: { a: T2 } });
    const merged = mergeVaultBodies(stale, purged);
    expect(merged.items).toEqual([]);
    expect(mergeVaultBodies(purged, stale).items).toEqual([]);
  });

  it("keeps a credential edited after the purge, as an unbound one", () => {
    const own = splitAccount(
      [],
      { ...account("a"), methods: [password("a:p")] },
      T0,
    ).map((item) =>
      item.id === "a:p" ? { ...item, updatedAt: "2026-02-01" } : item,
    );
    const merged = mergeVaultBodies(body(own), body([], { items: { a: T2 } }));
    expect(merged.items.map((item) => item.id)).toEqual(["a:p"]);
    expect(unboundCredentials(merged.items)).toHaveLength(1);
  });

  it("converges whichever side is the stale one", () => {
    const stale = body([
      { ...account("a", "Billing", T0), methods: [password("a:p", "old")] },
    ]);
    const fresh = body(
      splitAccount(
        [],
        { ...account("a", "Billing", T1), methods: [password("a:p", "new")] },
        T1,
      ),
    );
    const one = mergeVaultBodies(stale, fresh);
    const two = mergeVaultBodies(fresh, stale);
    expect(resolveAccounts(one.items)).toEqual(resolveAccounts(two.items));
    const merged = resolveAccounts(one.items).find((item) => item.id === "a");
    expect(merged?.kind === "account" && merged.methods).toMatchObject([
      { secret: "new" },
    ]);
  });

  it("keeps a method one device removed and another added since", () => {
    const base = splitAccount(
      [],
      { ...account("a"), methods: [password("a:p")] },
      T0,
    );
    const removed = splitAccount(base, { ...account("a"), methods: [] }, T1);
    const added = splitAccount(
      base,
      { ...account("a"), methods: [password("a:p"), apiKey("a:k")] },
      T2,
    );
    const merged = mergeVaultBodies(body(removed), body(added));
    const methods = resolveAccounts(merged.items).find(
      (item) => item.id === "a",
    );
    expect(
      methods?.kind === "account" && methods.methods.map((m) => m.id),
    ).toEqual(["a:k"]);
  });
});
