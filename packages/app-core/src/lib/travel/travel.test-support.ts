/**
 * An in-memory origin for travel tests: files by their storage names, a tomb
 * registry, and the calls the travel code made into the rest of the app.
 */

import { kvFileName } from "../kv.js";
import {
  type TravelDeps,
  type TravelVaultInfo,
  completeDeparture,
  packDeparture,
} from "./depart.js";
import type { TravelStorage } from "./storage.js";

type FakeState = {
  files: Map<string, string>;
  tombs: Set<string>;
  forgotten: string[][];
  welcomed: string[][];
  durable: boolean;
  duress: boolean;
  owner: boolean;
  legacy: string[];
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
    legacy: [],
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
    legacyVaults: async () => origin.legacy,
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

export const PRJ_WORK = "prj_1a2b3c4d-0000-4000-8000-00000000work";
export const PRJ_TRIP = "prj_9f8e7d6c-0000-4000-8000-00000000trip";
export const ACK = { bundleSaved: true, codeRecorded: true };

/** personal + Work stay home, Trip travels and is the open vault. */
export function packedDevice(): FakeOrigin {
  const origin = fakeOrigin();
  putVault(origin, "personal");
  putVault(origin, PRJ_WORK);
  putVault(origin, PRJ_TRIP);
  origin.files.set(kvFileName("vault.attempts.v1"), '{"count":0}');
  origin.files.set(kvFileName(`project.${PRJ_WORK}.vault.attempts.v1`), "{}");
  origin.files.set(kvFileName("guest-access.v1"), '{"allow":true}');
  origin.vaults = [
    vault("personal"),
    vault(PRJ_WORK, "locked", "Work"),
    vault(PRJ_TRIP, "open", "Trip"),
    { ...vault("guest", "empty"), kind: "guest" },
  ];
  return origin;
}

export async function depart(origin: FakeOrigin, safe: string[]) {
  const packed = await packDeparture(origin.deps, { safe });
  if (!packed.ok) throw new Error(`refused: ${packed.code}`);
  const done = await completeDeparture(origin.deps, packed.pkg, ACK);
  if (!done.ok) throw new Error(`refused: ${done.code}`);
  return { pkg: packed.pkg, receipt: done.receipt };
}
