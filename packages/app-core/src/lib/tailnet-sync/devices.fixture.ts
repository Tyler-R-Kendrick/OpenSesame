/**
 * Two devices in one test process (ADR 0144). Each device owns its own file
 * storage, installed behind `vfsSeams` only while that device is acting, and
 * its own `VaultStore`, so nothing one device writes is visible to the other
 * except through the drive — the same isolation two phones have.
 */
import { onTestFinished } from "vitest";
import { type Host, configureHost, host } from "../../host.js";
import { VaultStore } from "../vault/store.js";
import { type VfsSeams, vfsFlush, vfsSeams } from "../vfs.js";

export type Device = {
  name: string;
  store: VaultStore;
  files: Map<string, string>;
  seams: Pick<
    VfsSeams,
    "readRaw" | "writeRaw" | "writeRawGuarded" | "deleteRaw"
  >;
};
const contexts = new WeakMap<Device, Host>();

export function device(name: string): Device {
  const files = new Map<string, string>();
  const on: Device = {
    name,
    store: new VaultStore(),
    files,
    seams: {
      readRaw: (key) => files.get(key) ?? null,
      writeRaw: async (key, value) => {
        files.set(key, value);
      },
      writeRawGuarded: async (key, value, beforeCommit) => {
        beforeCommit();
        files.set(key, value);
      },
      deleteRaw: async (key) => {
        files.delete(key);
      },
    },
  };
  // Each device remains active through the test, then ends in its own realm.
  onTestFinished(() => closeDevice(on));
  return on;
}

const original = {
  readRaw: vfsSeams.readRaw,
  writeRaw: vfsSeams.writeRaw,
  writeRawGuarded: vfsSeams.writeRawGuarded,
  deleteRaw: vfsSeams.deleteRaw,
};

/** Run `act` as `on`: its storage is the only storage while it runs. */
export async function as<T>(on: Device, act: () => Promise<T>): Promise<T> {
  contexts.set(on, host());
  await vfsFlush();
  Object.assign(vfsSeams, on.seams);
  try {
    return await act();
  } finally {
    try {
      await on.store.flushPendingWrites();
      await vfsFlush();
    } finally {
      Object.assign(vfsSeams, original);
    }
  }
}

async function closeDevice(on: Device): Promise<void> {
  const previous = host();
  configureHost(contexts.get(on) ?? previous);
  try {
    await as(on, async () => {
      try {
        await on.store.flushPendingWrites();
      } finally {
        on.store.lock();
      }
    });
  } finally {
    contexts.delete(on);
    configureHost(previous);
  }
}

/** Every item name the device's open vault shows, sorted. */
export function itemNames(on: Device): string[] {
  return on.store
    .getSnapshot()
    .items.map((item) => item.name)
    .sort();
}
