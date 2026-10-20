/**
 * Environments in a vault body (ADR 0194): what a name may be, how two
 * devices' lists and an item's cells merge, and how an edit is stamped so a
 * wrong clock cannot lose it.
 */
import { describe, expect, it } from "vitest";
import { createCredential } from "./credential.js";
import { canBeKey } from "./environment-keys.js";
import {
  type VaultEnvironments,
  cellOf,
  environmentNames,
  mergeEnvironments,
} from "./environments.js";
import { mergeItem } from "./item-merge.js";
import { mergeVaultBodies, sameVaultContent } from "./merge.js";
import {
  type NoteItem,
  type VaultBody,
  type VaultItem,
  createItem,
} from "./model.js";
import { captureBefore, changedFieldKeys, restampEdits } from "./stamps.js";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = new Date("2026-01-02T00:00:00.000Z");
const T2 = new Date("2026-01-03T00:00:00.000Z");

function key(id: string): NoteItem {
  const item = createItem("note", "Stripe key");
  if (item.kind !== "note") throw new Error("not a note");
  return { ...item, id, createdAt: T0, updatedAt: T0 };
}

/** One device's copy after an edit made at `now`, stamped as the store does. */
function editedAt(
  now: Date,
  change: (item: NoteItem) => NoteItem,
  from: NoteItem,
): NoteItem {
  const target: VaultBody = { v: 1, items: [from], folders: [] };
  const before = captureBefore(target);
  target.items = [{ ...change(from), updatedAt: now.toISOString() }];
  restampEdits(before, target, now);
  const [out] = target.items;
  if (out?.kind !== "note") throw new Error("not a note");
  return out;
}

function both(a: VaultItem, b: VaultItem): VaultItem {
  const ab = mergeItem(a, b);
  expect(mergeItem(b, a)).toEqual(ab);
  return ab;
}

describe("which items may be keys", () => {
  it("is a live item that is not retired and not a one-time share record", () => {
    expect(canBeKey(key("a"))).toBe(true);
    expect(
      canBeKey({ ...key("a"), deletedAt: "2026-02-01T00:00:00.000Z" }),
    ).toBe(false);
    expect(canBeKey({ ...createItem("drop", "One-time share"), id: "d" })).toBe(
      false,
    );
    const own = createCredential(
      { id: "c", type: "api-key", key: "k", header: "" },
      "Standalone token",
    );
    expect(canBeKey(own)).toBe(true);
    expect(canBeKey({ ...own, accountId: "account" })).toBe(false);
  });
});

describe("the environment list across two devices", () => {
  const added: VaultEnvironments = {
    staging: { at: "2026-01-02T00:00:00.000Z" },
  };

  it("takes the union, either order", () => {
    const other: VaultEnvironments = {
      production: { at: "2026-01-03T00:00:00.000Z" },
    };
    const merged = mergeEnvironments(added, other);
    expect(merged).toEqual({ ...added, ...other });
    expect(mergeEnvironments(other, added)).toEqual(merged);
  });

  it("keeps a removal that is later than the add, so the name stays gone", () => {
    const removed: VaultEnvironments = {
      staging: { at: "2026-01-04T00:00:00.000Z", removed: true },
    };
    const merged = mergeEnvironments(added, removed);
    expect(environmentNames(merged)).toEqual([]);
    expect(mergeEnvironments(removed, added)).toEqual(merged);
  });

  it("lets a later re-add win over an earlier removal", () => {
    const removed: VaultEnvironments = {
      staging: { at: "2026-01-04T00:00:00.000Z", removed: true },
    };
    const again: VaultEnvironments = {
      staging: { at: "2026-01-05T00:00:00.000Z" },
    };
    expect(environmentNames(mergeEnvironments(removed, again))).toEqual([
      "staging",
    ]);
  });

  it("settles a tie to the removal in either order", () => {
    const at = "2026-01-04T00:00:00.000Z";
    const live: VaultEnvironments = { staging: { at } };
    const gone: VaultEnvironments = { staging: { at, removed: true } };
    expect(mergeEnvironments(live, gone)).toEqual(gone);
    expect(mergeEnvironments(gone, live)).toEqual(gone);
  });

  it("has nothing to carry when neither side has any", () => {
    expect(mergeEnvironments(undefined, undefined)).toBeUndefined();
  });

  it("travels with a whole-vault merge and counts as content", () => {
    const left: VaultBody = {
      v: 1,
      items: [],
      folders: [],
      environments: added,
    };
    const right: VaultBody = { v: 1, items: [], folders: [] };
    const merged = mergeVaultBodies(left, right);
    expect(merged.environments).toEqual(added);
    expect(mergeVaultBodies(right, left).environments).toEqual(added);
    expect(sameVaultContent(left, right)).toBe(false);
    expect(sameVaultContent(merged, left)).toBe(true);
  });
});

describe("an environment one device removed", () => {
  const live: VaultEnvironments = {
    staging: { at: "2026-01-01T00:00:00.000Z" },
    production: { at: "2026-01-01T00:00:00.000Z" },
  };
  const withoutStaging: VaultEnvironments = {
    ...live,
    staging: { at: "2026-01-04T00:00:00.000Z", removed: true },
  };
  const bodyOf = (
    environments: VaultEnvironments,
    item: NoteItem,
  ): VaultBody => ({ v: 1, items: [item], folders: [], environments });

  const base = {
    ...key("k"),
    environments: {
      staging: { value: "s0" },
      production: { value: "p0", required: true },
    },
  };

  it("leaves no value behind when the other device wrote one in the meantime", () => {
    // This device removed staging (its cells went with it); the other, still
    // seeing staging, set a value for it afterwards.
    const here = editedAt(
      T1,
      (item) => ({
        ...item,
        environments: { production: { value: "p0", required: true } },
      }),
      base,
    );
    const there = editedAt(
      T2,
      (item) => ({
        ...item,
        environments: {
          ...item.environments,
          staging: { value: "late secret" },
        },
      }),
      base,
    );
    const orders: ReadonlyArray<readonly [VaultBody, VaultBody]> = [
      [bodyOf(withoutStaging, here), bodyOf(live, there)],
      [bodyOf(live, there), bodyOf(withoutStaging, here)],
    ];
    for (const [a, b] of orders) {
      const merged = mergeVaultBodies(a, b);
      const [item] = merged.items;
      expect(item?.environments).toEqual({
        production: { value: "p0", required: true },
      });
      expect(JSON.stringify(merged)).not.toContain("late secret");
    }
  });

  it("keeps every cell of an environment that is still live", () => {
    const merged = mergeVaultBodies(
      bodyOf(live, base),
      bodyOf(live, { ...base }),
    );
    expect(merged.items[0]?.environments).toEqual(base.environments);
  });

  it("keeps the key itself when its last cell goes", () => {
    const only = { ...base, environments: { staging: { value: "s0" } } };
    const merged = mergeVaultBodies(
      bodyOf(withoutStaging, { ...base, environments: {} }),
      bodyOf(live, only),
    );
    expect(merged.items[0]?.environments).toEqual({});
  });

  it("holds when a vault has no environment list at all", () => {
    const merged = mergeVaultBodies(
      { v: 1, items: [base], folders: [] },
      { v: 1, items: [base], folders: [] },
    );
    expect(merged.items[0]?.environments).toEqual(base.environments);
  });
});

describe("an item's cells across two devices", () => {
  const ORIGINAL = {
    ...key("k"),
    environments: {
      staging: { value: "s0", required: false },
      production: { value: "p0", required: true },
    },
  };

  it("drops cells when one copy took the item out of the schema", () => {
    const excluded = editedAt(
      T2,
      (item) => ({ ...item, environmentsExcluded: true }),
      ORIGINAL,
    );
    const stale = editedAt(
      T1,
      (item) => ({
        ...item,
        environments: { production: { value: "stale-secret" } },
      }),
      ORIGINAL,
    );
    const merged = both(excluded, stale);
    expect(merged.environmentsExcluded).toBe(true);
    expect(merged.environments).toBeUndefined();
    expect(JSON.stringify(merged)).not.toContain("stale-secret");
  });

  it("keeps production edited on one device and staging on the other", () => {
    const here = editedAt(
      T1,
      (item) => ({
        ...item,
        environments: {
          ...item.environments,
          production: { value: "p1", required: true },
        },
      }),
      ORIGINAL,
    );
    const there = editedAt(
      T2,
      (item) => ({
        ...item,
        environments: {
          ...item.environments,
          staging: { value: "s1", required: false },
        },
      }),
      ORIGINAL,
    );
    const merged = both(here, there);
    expect(merged.environments).toEqual({
      staging: { value: "s1", required: false },
      production: { value: "p1", required: true },
    });
  });

  it("stamps exactly the cell that changed", () => {
    const next = {
      ...ORIGINAL,
      environments: {
        ...ORIGINAL.environments,
        production: { value: "p9", required: true },
      },
    };
    expect(changedFieldKeys(ORIGINAL, next)).toEqual([
      "environments.production",
    ]);
  });

  it("keeps the later of two edits to one cell", () => {
    const earlier = editedAt(
      T1,
      (item) => ({
        ...item,
        environments: { ...item.environments, production: { value: "a" } },
      }),
      ORIGINAL,
    );
    const later = editedAt(
      T2,
      (item) => ({
        ...item,
        environments: { ...item.environments, production: { value: "b" } },
      }),
      ORIGINAL,
    );
    expect(cellOf(both(earlier, later).environments, "production")).toEqual({
      value: "b",
    });
  });

  it("lets a cell removed later than the other side changed it stay removed", () => {
    const edited = editedAt(
      T1,
      (item) => ({
        ...item,
        environments: { ...item.environments, staging: { value: "s1" } },
      }),
      ORIGINAL,
    );
    const removed = editedAt(
      T2,
      (item) => ({
        ...item,
        environments: { production: { value: "p0", required: true } },
      }),
      ORIGINAL,
    );
    expect(both(edited, removed).environments).toEqual({
      production: { value: "p0", required: true },
    });
  });

  it("keeps an item out of the schema once the later copy took it out", () => {
    const { environments: _gone, ...plain } = ORIGINAL;
    const out = editedAt(T2, () => plain, ORIGINAL);
    const merged = both(ORIGINAL, out);
    expect("environments" in merged).toBe(false);
  });

  it("stamps an environment added behind a wrong clock after everything seen", () => {
    const body: VaultBody = {
      v: 1,
      items: [],
      folders: [],
      environments: { staging: { at: "2026-06-01T00:00:00.000Z" } },
    };
    const before = captureBefore(body);
    // The clock reads January; the body has already seen June.
    body.environments = {
      ...body.environments,
      production: { at: "2026-01-01T00:00:00.000Z" },
    };
    restampEdits(before, body, T1);
    const stamped = body.environments?.production?.at ?? "";
    expect(stamped > "2026-06-01T00:00:00.000Z").toBe(true);
    expect(body.environments?.staging?.at).toBe("2026-06-01T00:00:00.000Z");
  });
});
