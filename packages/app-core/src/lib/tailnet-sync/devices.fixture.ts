/**
 * Two devices in one test process (ADR 0144). Each device owns its own file
 * storage, installed behind `vfsSeams` only while that device is acting, and
 * its own `VaultStore`, so nothing one device writes is visible to the other
 * except through the drive — the same isolation two phones have.
 */
import { VaultStore } from "../vault/store.js";
import { type VfsSeams, vfsFlush, vfsSeams } from "../vfs.js";

export type Device = {
  name: string;
  store: VaultStore;
  files: Map<string, string>;
  seams: Pick<VfsSeams, "readRaw" | "writeRaw" | "deleteRaw">;
};

export function device(name: string): Device {
  const files = new Map<string, string>();
  return {
    name,
    store: new VaultStore(),
    files,
    seams: {
      readRaw: (key) => files.get(key) ?? null,
      writeRaw: async (key, value) => {
        files.set(key, value);
      },
      deleteRaw: async (key) => {
        files.delete(key);
      },
    },
  };
}

const original = {
  readRaw: vfsSeams.readRaw,
  writeRaw: vfsSeams.writeRaw,
  deleteRaw: vfsSeams.deleteRaw,
};

/** Run `act` as `on`: its storage is the only storage while it runs. */
export async function as<T>(on: Device, act: () => Promise<T>): Promise<T> {
  await vfsFlush();
  Object.assign(vfsSeams, on.seams);
  try {
    return await act();
  } finally {
    await on.store.flushPendingWrites();
    await vfsFlush();
    Object.assign(vfsSeams, original);
  }
}

/** Every item name the device's open vault shows, sorted. */
export function itemNames(on: Device): string[] {
  return on.store
    .getSnapshot()
    .items.map((item) => item.name)
    .sort();
}
