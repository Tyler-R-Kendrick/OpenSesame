/**
 * Edits stamped after everything a device has seen (ADR 0144): a device whose
 * clock runs behind still wins over the copy it edited, and its purge still
 * buries the copy it saw.
 */
import { describe, expect, it } from "vitest";
import { mergeVaultBodies, withTombstone } from "./merge.js";
import {
  type LoginItem,
  type VaultBody,
  type VaultItem,
  createItem,
} from "./model.js";
import {
  captureBefore,
  changedFieldKeys,
  latestStamp,
  restampEdits,
  stampAfter,
} from "./stamps.js";

const T0 = "2026-01-01T00:00:00.000Z";
/** What a device whose clock is an hour ahead wrote. */
const AHEAD = "2026-01-01T13:00:00.000Z";
/** The wall clock of a device an hour behind it. */
const BEHIND = new Date("2026-01-01T12:00:00.000Z");

function login(id: string, at: string): LoginItem {
  return {
    ...createItem("login", id),
    id,
    createdAt: T0,
    updatedAt: at,
  };
}

function body(items: VaultItem[]): VaultBody {
  return { v: 1, items, folders: [] };
}

/** Make `change` as the store does: stamped after what the body had seen. */
function edit(
  target: VaultBody,
  change: (body: VaultBody) => void,
  now = BEHIND,
): void {
  const before = captureBefore(target);
  change(target);
  restampEdits(before, target, now);
}

function rename(id: string, name: string) {
  return (target: VaultBody) => {
    target.items = target.items.map((item) =>
      item.id === id
        ? { ...item, name, updatedAt: BEHIND.toISOString() }
        : item,
    );
  };
}

describe("stampAfter", () => {
  it("is the wall clock when that is past everything seen", () => {
    expect(stampAfter("2026-01-01T00:00:00.000Z", BEHIND)).toBe(
      BEHIND.toISOString(),
    );
    expect(stampAfter("", BEHIND)).toBe(BEHIND.toISOString());
  });

  it("is one millisecond past what was seen when the clock is not", () => {
    expect(stampAfter(AHEAD, BEHIND)).toBe("2026-01-01T13:00:00.001Z");
    expect(stampAfter(BEHIND.toISOString(), BEHIND)).toBe(
      "2026-01-01T12:00:00.001Z",
    );
  });
});

describe("restampEdits", () => {
  it("stamps an edit after the copy a fast clock wrote, so it wins", () => {
    // Device A (an hour ahead) wrote the item; device B (behind) renames it.
    const fromA = body([login("x", AHEAD)]);
    const onB = structuredClone(fromA);
    edit(onB, rename("x", "Renamed on B"));
    const renamed = onB.items[0];
    expect(renamed?.updatedAt).toBe("2026-01-01T13:00:00.001Z");
    expect(renamed?.fieldTimes).toEqual({ name: "2026-01-01T13:00:00.001Z" });
    // B's later edit survives the merge with A's copy, either way round.
    expect(mergeVaultBodies(fromA, onB).items[0]?.name).toBe("Renamed on B");
    expect(mergeVaultBodies(onB, fromA).items[0]?.name).toBe("Renamed on B");
  });

  it("buries a copy stamped by a fast clock when a slow one purges it", () => {
    const fromA = body([login("x", AHEAD)]);
    const onB = structuredClone(fromA);
    edit(onB, (target) => {
      target.items = [];
      target.tombstones = withTombstone(
        target.tombstones,
        "items",
        ["x"],
        BEHIND.toISOString(),
      );
    });
    expect(onB.tombstones?.items?.x).toBe("2026-01-01T13:00:00.001Z");
    expect(mergeVaultBodies(fromA, onB).items).toEqual([]);
  });

  it("leaves untouched and new records as they were", () => {
    const start = body([login("x", T0), login("y", AHEAD)]);
    const kept = start.items[1];
    edit(start, (target) => {
      target.items = [...target.items, login("new", T0)];
    });
    expect(start.items[1]).toBe(kept);
    expect(start.items[2]?.updatedAt).toBe(T0);
    expect(start.items[2]?.fieldTimes).toBeUndefined();
  });

  it("restamps a folder rename and an uninstall the same way", () => {
    const start: VaultBody = {
      ...body([login("x", AHEAD)]),
      folders: [{ id: "f", name: "Work", createdAt: T0 }],
    };
    edit(start, (target) => {
      target.folders = [
        { id: "f", name: "Home", createdAt: T0, updatedAt: T0 },
      ];
      target.tombstones = withTombstone(undefined, "itemTypes", ["t"], T0);
    });
    expect(start.folders[0]?.updatedAt).toBe("2026-01-01T13:00:00.001Z");
    expect(start.tombstones?.itemTypes?.t).toBe("2026-01-01T13:00:00.001Z");
  });

  it("names each changed field, typed value and custom field", () => {
    const before = login("x", T0);
    const after: LoginItem = {
      ...before,
      username: "ada",
      fields: [{ id: "f1", name: "PIN", value: "1", hidden: true }],
    };
    expect(changedFieldKeys(before, after).sort()).toEqual([
      "fields",
      "fields.f1",
      "username",
    ]);
  });
});

describe("latestStamp", () => {
  it("reads items, field times, folders, tombstones and installs", () => {
    const latest = "2027-01-01T00:00:00.000Z";
    const cases: VaultBody[] = [
      body([{ ...login("x", T0), deletedAt: latest }]),
      body([{ ...login("x", T0), fieldTimes: { name: latest } }]),
      {
        ...body([]),
        folders: [{ id: "f", name: "", createdAt: T0, updatedAt: latest }],
      },
      { ...body([]), tombstones: { items: { gone: latest } } },
      { ...body([]), itemTypesAt: { t: latest } },
    ];
    for (const target of cases) expect(latestStamp(target)).toBe(latest);
  });
});
