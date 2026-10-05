/**
 * An open vault in memory for the items-bundle tests: a body the real pure
 * edits (`vault/item-departure.ts`) change, and the seams the travel code
 * calls into the rest of the app through.
 */

import {
  type Folder,
  type VaultBody,
  type VaultItem,
  createItem,
  emptyBody,
} from "@opensesame/vault-core";
import { restoreIntoBody, withdrawFromBody } from "../vault/item-departure.js";
import type { ItemsCopy, ItemsDeps } from "./items-depart.js";

type FakeState = {
  body: VaultBody;
  tomb: string;
  createdAt: string;
  copies: ItemsCopy[];
  shared: Set<string>;
  duress: boolean;
  owner: boolean;
  durable: boolean;
  /** Fail the next purge of this name, as a store that would not open. */
  failPurge: Set<string>;
  /** Fail a purge on its nth call only: fine before the removal, broken after. */
  failOnCall: Map<string, number>;
  calls: Map<string, number>;
  purged: { activity: string[][]; passwords: string[][]; cache: string[] };
  /** Called inside the mutation, as another tab's write would land. */
  beforeWithdraw: (() => void) | null;
};

export type FakeItemsVault = FakeState & { deps: ItemsDeps };

export function login(name: string, extra: Partial<VaultItem> = {}): VaultItem {
  const item = createItem("login", name);
  return Object.assign(item, extra);
}

export function folder(id: string, name: string): Folder {
  return { id, name, createdAt: "2026-01-01T00:00:00.000Z" };
}

export function fakeItemsVault(
  items: readonly VaultItem[] = [],
  folders: readonly Folder[] = [],
): FakeItemsVault {
  const state: FakeState = {
    body: { ...emptyBody(), items: [...items], folders: [...folders] },
    tomb: "personal",
    createdAt: "2026-02-02T00:00:00.000Z",
    copies: [],
    shared: new Set(),
    duress: false,
    owner: true,
    durable: true,
    failPurge: new Set(),
    failOnCall: new Map(),
    calls: new Map(),
    purged: { activity: [], passwords: [], cache: [] },
    beforeWithdraw: null,
  };
  const purge = (name: string) => {
    const call = (state.calls.get(name) ?? 0) + 1;
    state.calls.set(name, call);
    if (state.failPurge.has(name) || state.failOnCall.get(name) === call) {
      throw new Error(`${name} would not open`);
    }
  };
  const deps: ItemsDeps = {
    storage: { durable: () => state.durable },
    duressActive: async () => state.duress,
    ownerPresent: () => state.owner,
    exclusive: (work) => work(),
    now: () => new Date("2026-10-05T10:00:00.000Z"),
    vault: () =>
      state.owner
        ? {
            tomb: state.tomb,
            createdAt: state.createdAt,
            items: state.body.items,
            folders: state.body.folders,
          }
        : null,
    sharedItems: async () => state.shared,
    copiesInPlay: async () => state.copies,
    withdraw: async (plan) => {
      state.beforeWithdraw?.();
      withdrawFromBody(state.body, plan);
    },
    restore: async (back) => restoreIntoBody(state.body, back),
    purge: {
      activity: async (_tomb, ids) => {
        purge("activity");
        state.purged.activity.push([...ids]);
        return 1;
      },
      passwords: async (_tomb, ids) => {
        purge("passwords");
        state.purged.passwords.push([...ids]);
        return 1;
      },
      offlineCache: async (tomb) => {
        purge("offline_cache");
        state.purged.cache.push(tomb);
      },
    },
  };
  return Object.assign(state, { deps });
}
