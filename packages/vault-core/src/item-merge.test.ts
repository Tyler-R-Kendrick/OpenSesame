/**
 * Two devices' edits to one item, merged field by field (ADR 0144): different
 * fields both survive, the same field keeps the later change, and the result
 * is the same whichever device merges.
 */
import { describe, expect, it } from "vitest";
import { accountTotp, manualPassword, passwordMethod } from "./account.js";
import { itemVersion, mergeItem } from "./item-merge.js";
import { mergeVaultBodies, sameVaultContent } from "./merge.js";
import {
  type AccountItem,
  type CustomField,
  type TypedItem,
  type VaultBody,
  type VaultItem,
  createItem,
} from "./model.js";
import { captureBefore, restampEdits } from "./stamps.js";

const T0 = "2026-01-01T00:00:00.000Z";

/** What the account's password method stores: the field the merge carries. */
function storedPassword(item: AccountItem): string | undefined {
  return passwordMethod(item)?.secret;
}
const T1 = new Date("2026-01-02T00:00:00.000Z");
const T2 = new Date("2026-01-03T00:00:00.000Z");

/** The account with its password method's secret replaced. */
function withPassword(item: AccountItem, secret: string): AccountItem {
  return {
    ...item,
    methods: item.methods.map((method) =>
      method.type === "password" ? { ...method, secret } : method,
    ),
  };
}

const ORIGINAL: AccountItem = {
  ...account(createItem("account", "Bank")),
  // A password the person typed: what a merge carries as a stored field.
  methods: [manualPassword("x:password", "first", T0)],
  id: "x",
  createdAt: T0,
  updatedAt: T0,
  username: "ada",
  notes: "",
  fields: [
    { id: "keep", name: "Branch", value: "Leeds", hidden: false },
    { id: "drop", name: "Old PIN", value: "0000", hidden: true },
  ],
};

/** One device's copy after an edit made at `now`, stamped as the store does. */
function editedAt(
  now: Date,
  change: (item: AccountItem) => AccountItem,
  from: AccountItem = ORIGINAL,
): AccountItem {
  const target: VaultBody = { v: 1, items: [from], folders: [] };
  const before = captureBefore(target);
  target.items = [{ ...change(from), updatedAt: now.toISOString() }];
  restampEdits(before, target, now);
  const [out] = target.items;
  if (out?.kind !== "account") throw new Error("not an account");
  return out;
}

function both(a: VaultItem, b: VaultItem): VaultItem {
  const ab = mergeItem(a, b);
  expect(JSON.stringify(mergeItem(b, a))).toBe(JSON.stringify(ab));
  return ab;
}

function account(item: VaultItem): AccountItem {
  if (item.kind !== "account") throw new Error("not an account");
  return item;
}

describe("mergeItem", () => {
  it("keeps both devices' edits to different fields", () => {
    const onPhone = editedAt(T1, (item) => ({ ...item, username: "ada@bank" }));
    const onDesk = editedAt(T2, (item) => ({ ...item, notes: "Call first" }));
    const merged = account(both(onPhone, onDesk));
    expect(merged.username).toBe("ada@bank");
    expect(merged.notes).toBe("Call first");
    expect(storedPassword(merged)).toBe("first");
    expect(merged.updatedAt).toBe(T2.toISOString());
    expect(merged.fieldTimes).toEqual({
      username: T1.toISOString(),
      notes: T2.toISOString(),
    });
  });

  it("keeps the later change to the same field", () => {
    const earlier = editedAt(T1, (item) => withPassword(item, "second"));
    const later = editedAt(T2, (item) => withPassword(item, "third"));
    expect(storedPassword(account(both(earlier, later)))).toBe("third");
  });

  it("merges login methods one at a time (ADR 0172)", () => {
    const onPhone = editedAt(T1, (item) => withPassword(item, "second"));
    const onDesk = editedAt(T2, (item) => ({
      ...item,
      methods: [
        ...item.methods,
        { id: "x:authenticator", type: "authenticator", secret: "JBSWY3DP" },
      ],
    }));
    const merged = account(both(onPhone, onDesk));
    expect(storedPassword(merged)).toBe("second");
    expect(accountTotp(merged)).toBe("JBSWY3DP");
    expect(merged.fieldTimes).toMatchObject({
      [`methods.${passwordMethod(ORIGINAL)?.id}`]: T1.toISOString(),
      "methods.x:authenticator": T2.toISOString(),
    });
  });

  it("merges custom fields one at a time: adds, edits and removals", () => {
    const pin: CustomField = {
      id: "pin",
      name: "PIN",
      value: "1",
      hidden: true,
    };
    const onPhone = editedAt(T1, (item) => ({
      ...item,
      fields: [...item.fields, pin],
    }));
    const onDesk = editedAt(T2, (item) => ({
      ...item,
      fields: item.fields
        .filter((field) => field.id !== "drop")
        .map((field) =>
          field.id === "keep" ? { ...field, value: "York" } : field,
        ),
    }));
    expect(account(both(onPhone, onDesk)).fields).toEqual([
      { id: "keep", name: "Branch", value: "York", hidden: false },
      pin,
    ]);
  });

  it("keeps a custom field edited after the other device removed it", () => {
    const removed = editedAt(T1, (item) => ({
      ...item,
      fields: item.fields.filter((field) => field.id !== "drop"),
    }));
    const edited = editedAt(T2, (item) => ({
      ...item,
      fields: item.fields.map((field) =>
        field.id === "drop" ? { ...field, value: "9999" } : field,
      ),
    }));
    expect(account(both(removed, edited)).fields.map((f) => f.value)).toEqual([
      "Leeds",
      "9999",
    ]);
  });

  it("merges a typed item's values one at a time", () => {
    const typed: TypedItem = {
      id: "w",
      kind: "typed",
      typeId: "wifi",
      name: "Wi-Fi",
      folderId: null,
      favorite: false,
      notes: "",
      fields: [],
      values: { ssid: "home", password: "a" },
      createdAt: T0,
      updatedAt: T0,
      deletedAt: null,
    };
    const stamp = (now: Date, values: TypedItem["values"]): TypedItem => {
      const target: VaultBody = { v: 1, items: [typed], folders: [] };
      const before = captureBefore(target);
      target.items = [{ ...typed, values, updatedAt: now.toISOString() }];
      restampEdits(before, target, now);
      const [out] = target.items;
      if (out?.kind !== "typed") throw new Error("not typed");
      return out;
    };
    const a = stamp(T1, { ssid: "home-5g", password: "a" });
    const b = stamp(T2, { ssid: "home", password: "b" });
    const merged = both(a, b);
    if (merged.kind !== "typed") throw new Error("not typed");
    expect(merged.values).toEqual({ ssid: "home-5g", password: "b" });
  });

  it("trashes and restores as a field like any other", () => {
    const trashed = editedAt(T1, (item) => ({
      ...item,
      deletedAt: T1.toISOString(),
    }));
    const renamed = editedAt(T2, (item) => ({ ...item, name: "Bank (old)" }));
    const merged = both(trashed, renamed);
    expect(merged.deletedAt).toBe(T1.toISOString());
    expect(merged.name).toBe("Bank (old)");
  });

  it("keeps the newer whole copy when neither records field times", () => {
    const older = { ...ORIGINAL, username: "a", updatedAt: T1.toISOString() };
    const newer = { ...ORIGINAL, notes: "n", updatedAt: T2.toISOString() };
    expect(both(older, newer)).toBe(newer);
  });

  it("settles: merging again changes nothing", () => {
    const a = editedAt(T1, (item) => ({ ...item, username: "u" }));
    const b = editedAt(T2, (item) => ({ ...item, notes: "n" }));
    const once = mergeItem(a, b);
    expect(mergeItem(once, b)).toEqual(once);
    expect(mergeItem(a, once)).toEqual(once);
    expect(itemVersion(once) >= itemVersion(b)).toBe(true);
  });
});

describe("mergeVaultBodies with field times", () => {
  it("converges two devices that edited one item apart", () => {
    const phone: VaultBody = {
      v: 1,
      folders: [],
      items: [editedAt(T1, (item) => ({ ...item, username: "u" }))],
    };
    const desk: VaultBody = {
      v: 1,
      folders: [],
      items: [editedAt(T2, (item) => ({ ...item, notes: "n" }))],
    };
    const onPhone = mergeVaultBodies(phone, desk);
    const onDesk = mergeVaultBodies(desk, phone);
    expect(sameVaultContent(onPhone, onDesk)).toBe(true);
    expect(sameVaultContent(mergeVaultBodies(onPhone, desk), onPhone)).toBe(
      true,
    );
  });
});
