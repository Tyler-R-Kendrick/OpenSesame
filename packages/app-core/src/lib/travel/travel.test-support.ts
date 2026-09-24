/**
 * An in-memory origin for travel tests: files by their storage names, a tomb
 * registry, and the calls the travel code made into the rest of the app.
 */

import { kvFileName } from "../kv.js";
import type { TravelDeps, TravelVaultInfo } from "./depart.js";
import type { TravelStorage } from "./storage.js";

type FakeState = {
  files: Map<string, string>;
  tombs: Set<string>;
  forgotten: string[][];
  welcomed: string[][];
  durable: boolean;
  duress: boolean;
  owner: boolean;
  vaults: TravelVaultInfo[];
};

export type FakeOrigin = FakeState & { deps: TravelDeps };

export function tombFile(tomb: string, path: string): string {
  return kvFileName(`tomb/${tomb}/${path}`);
}

/** Seal-shaped ciphertext is all a vault's files look like from here. */
export function putVault(
  origin: FakeOrigin,
  id: string,
  body = `{"ivB64":"iv-${id}","ctB64":"ct-${id}"}`,
): void {
  origin.files.set(tombFile(id, "header"), `{"v":1,"createdAt":"${id}"}`);
  origin.files.set(tombFile(id, "body"), body);
  origin.files.set(
    tombFile(id, "config/prefs"),
    `{"ivB64":"p","ctB64":"${id}"}`,
  );
  origin.files.set(tombFile(id, "config/tree-collapsed"), `{"x":"${id}"}`);
  origin.tombs.add(id);
}

export function fakeOrigin(): FakeOrigin {
  const origin: FakeState = {
    files: new Map(),
    tombs: new Set(),
    forgotten: [],
    welcomed: [],
    durable: true,
    duress: false,
    owner: true,
    vaults: [],
  };
  const storage: TravelStorage = {
    durable: () => origin.durable,
    listFiles: async () => [...origin.files.keys()],
    read: async (file) => origin.files.get(file) ?? null,
    write: async (file, text) => {
      origin.files.set(file, text);
    },
    remove: async (file) => {
      origin.files.delete(file);
    },
    forget: (files) => {
      origin.forgotten.push([...files].sort());
    },
    tombs: () => [...origin.tombs].sort(),
    registerTomb: async (tomb) => {
      origin.tombs.add(tomb);
    },
    unregisterTomb: async (tomb) => {
      origin.tombs.delete(tomb);
    },
  };
  const deps: TravelDeps = {
    storage,
    vaults: () => origin.vaults,
    duressActive: async () => origin.duress,
    ownerPresent: () => origin.owner,
    forgetVaults: async (ids) => {
      origin.vaults = origin.vaults.filter((vault) => !ids.includes(vault.id));
    },
    welcomeVaults: async (ids) => {
      origin.welcomed.push([...ids]);
    },
    now: () => new Date("2026-09-24T08:00:00.000Z"),
  };
  return Object.assign(origin, { deps });
}

export function vault(
  id: string,
  state: TravelVaultInfo["state"] = "locked",
  name: string | null = null,
): TravelVaultInfo {
  return {
    id,
    kind: id === "personal" ? "personal" : "project",
    state,
    label: name ?? id,
    name,
  };
}
