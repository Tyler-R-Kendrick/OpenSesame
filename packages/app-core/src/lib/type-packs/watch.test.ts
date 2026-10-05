import type { VaultItem } from "@opensesame/vault-core";
import {
  dropPack,
  isPackLoaded,
  packEntries,
} from "@opensesame/vault-item-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { kvDelete } from "../kv.js";
import { clearNotices } from "../notices.js";
import { PACKS_KEY, readStoredPacks } from "./persist.js";
import { getPackSnapshot, resetPackStateForTests, statusOf } from "./state.js";
import { countPackItems, watchVaultTypes } from "./watch.js";

function typed(typeId: string): VaultItem {
  return {
    kind: "typed",
    typeId,
    id: `${typeId}-1`,
    name: typeId,
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
    deletedAt: null,
    values: {},
  };
}

function source(initial: VaultItem[]) {
  let items = initial;
  const listeners = new Set<() => void>();
  return {
    set(next: VaultItem[]) {
      items = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => ({ items }),
  };
}

beforeEach(() => {
  for (const entry of packEntries()) dropPack(entry.id);
  resetPackStateForTests();
  kvDelete(PACKS_KEY);
  clearNotices();
});

describe("watching the open vault", () => {
  it("counts items of pack types and ignores the rest", () => {
    expect(
      countPackItems([typed("wifi"), typed("wifi"), typed("community-thing")]),
    ).toEqual(new Map([["wifi", 2]]));
  });

  it("installs the type of an item it holds, without remembering a choice", async () => {
    const vault = source([typed("wifi")]);
    const stop = watchVaultTypes(vault);
    await vi.waitFor(() => expect(statusOf("wifi").phase).toBe("on"));
    expect(isPackLoaded("wifi")).toBe(true);
    expect(getPackSnapshot().counts).toEqual(new Map([["wifi", 1]]));
    expect(readStoredPacks().get("wifi")).toBeUndefined();
    stop();
  });

  it("picks up a type that arrives with a sync", async () => {
    const vault = source([]);
    const stop = watchVaultTypes(vault);
    expect(isPackLoaded("server")).toBe(false);
    vault.set([typed("server")]);
    await vi.waitFor(() => expect(isPackLoaded("server")).toBe(true));
    stop();
  });
});
