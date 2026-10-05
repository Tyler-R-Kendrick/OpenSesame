/**
 * A device for wipe tests: travel's in-memory origin (files by storage name, a
 * tomb registry) with a guest tomb, the duress journals and a few unrelated
 * files beside the vaults, and the wipe's seams over it.
 */

import { kvFileName } from "../../kv.js";
import {
  type FakeOrigin,
  PRJ_TRIP,
  PRJ_WORK,
  packedDevice,
  putVault,
  tombFile,
} from "../../travel/travel.test-support.js";
import {
  ENROLLMENT_STATE_KEY,
  INCIDENT_INTENT_KEY,
  INCIDENT_RECORD_KEY,
  journalKeysOf,
} from "../store/boot-keys.js";
import type { WipeDeps } from "./wipe.js";

export { PRJ_TRIP, PRJ_WORK, tombFile };

/** Files a wipe must leave exactly as they were. */
export const KEPT_FILES = [
  ...[ENROLLMENT_STATE_KEY, INCIDENT_INTENT_KEY, INCIDENT_RECORD_KEY].flatMap(
    (key) => journalKeysOf(key).map(kvFileName),
  ),
  kvFileName("guest-access.v1"),
  kvFileName("settings.v1"),
  kvFileName("travel.safe.v1"),
  tombFile("guest", "header"),
  tombFile("guest", "body"),
  tombFile("guest-scratch", "body"),
] as const;

export type VaultsDevice = FakeOrigin & {
  gone: string[][];
  removals: string[];
  wipeDeps: WipeDeps;
};

/** Personal and two projects, a guest tomb, the duress journals, other state. */
export function deviceWithVaults(): VaultsDevice {
  const origin = packedDevice();
  putVault(origin, "guest");
  putVault(origin, "guest-scratch");
  for (const file of KEPT_FILES) {
    if (!origin.files.has(file)) origin.files.set(file, `{"kept":"${file}"}`);
  }
  const gone: string[][] = [];
  const removals: string[] = [];
  const device = Object.assign(origin, { gone, removals });
  const { remove } = origin.deps.storage;
  origin.deps.storage.remove = async (file) => {
    device.removals.push(file);
    await remove(file);
  };
  const wipeDeps: WipeDeps = {
    storage: origin.deps.storage,
    knownIds: () => origin.vaults.map((vault) => vault.id),
    settle: async () => {},
    exclusive: (work) => work(),
    afterRemoval: async (gone) => {
      device.gone.push([...gone]);
    },
    now: () => new Date("2026-10-05T08:00:00.000Z"),
  };
  return Object.assign(device, { wipeDeps });
}

/** The files that belong to the vaults a wipe removes. */
export function vaultFiles(device: VaultsDevice): string[] {
  const owned = ["personal", PRJ_WORK, PRJ_TRIP].flatMap((id) => [
    tombFile(id, "header"),
    tombFile(id, "body"),
    tombFile(id, "config/prefs"),
    tombFile(id, "config/tree-collapsed"),
  ]);
  return owned.filter((file) => device.files.has(file));
}
