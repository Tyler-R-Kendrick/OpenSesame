/**
 * Two devices in one test process (ADR 0144). Each device owns its own file
 * storage, installed behind `vfsSeams` only while that device is acting, and
 * its own `VaultStore`, so nothing one device writes is visible to the other
 * except through the drive — the same isolation two phones have.
 */
import { deviceVfsNamespace } from "../__tests__/vfs-device-namespaces.js";
import { VaultStore } from "../vault/store.js";
import { type VfsSeams, vfsFlush, vfsSeams } from "../vfs.js";

export type Device = {
  name: string;
  store: VaultStore;
  files: Map<string, string>;
  seams: Pick<VfsSeams, "readRaw" | "writeRaw" | "deleteRaw">;
};

export function device(name: string): Device {
  if (deviceVfsNamespace.installedFactories === 0)
    throw new Error(
      "The simulated device admission namespaces were not installed.",
    );
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

/** Run `act` as `on`: its storage is the only storage while it runs. */
export async function as<T>(on: Device, act: () => Promise<T>): Promise<T> {
  await vfsFlush();
  const previousDevice = deviceVfsNamespace.current;
  const previous = {
    readRaw: vfsSeams.readRaw,
    writeRaw: vfsSeams.writeRaw,
    deleteRaw: vfsSeams.deleteRaw,
  };
  deviceVfsNamespace.current = on;
  Object.assign(vfsSeams, on.seams);
  try {
    return await act();
  } finally {
    try {
      await on.store.flushPendingWrites();
    } finally {
      try {
        await vfsFlush();
      } finally {
        deviceVfsNamespace.current = previousDevice;
        Object.assign(vfsSeams, previous);
      }
    }
  }
}

/** Every item name the device's open vault shows, sorted. */
export function itemNames(on: Device): string[] {
  return on.store
    .getSnapshot()
    .items.map((item) => item.name)
    .sort();
}
