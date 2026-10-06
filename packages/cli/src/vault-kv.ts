/** Node uses the core's sealed KV transport; legacy CLI snapshots migrate once. */
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { configureHost } from "@opensesame/app-core/host.js";
import { flushActivityLog } from "@opensesame/app-core/lib/activity-log.js";
import { LEGACY_CONNECTOR_PUBLIC_KEY } from "@opensesame/app-core/lib/device-connector-legacy-storage.js";
import { DURESS_BOOT_KEYS } from "@opensesame/app-core/lib/duress/store/boot-keys.js";
import {
  kvFlush,
  kvForgetAll,
  kvGet,
  kvHydrate,
  kvRefresh,
  kvSetDurable,
} from "@opensesame/app-core/lib/kv.js";
import { tombStorageKeys } from "@opensesame/app-core/lib/vault/tomb-migration.js";
import {
  TOMBS_REGISTRY_KEY,
  listTombs,
  vfsFlush,
} from "@opensesame/app-core/lib/vfs.js";
import { createNodeHost } from "@opensesame/app-core/node/host.js";
import { lockManager } from "@opensesame/app-core/ports.js";
import { isJsonObject, isString, overlapCast } from "@opensesame/os-domain";
import { headlessCapabilityArtifacts } from "./headless-composition.js";

export const vaultKvSeams = {
  readText: (path: string): Promise<string> => readFile(path, "utf8"),
};
let directory: string | null = null;

async function legacyRecords(
  stateDir: string,
): Promise<Map<string, string> | null> {
  let text: string;
  try {
    text = await vaultKvSeams.readText(join(stateDir, "vault-kv.json"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
  const parsed = overlapCast(JSON.parse(text));
  if (!isJsonObject(parsed)) throw new Error("Vault storage is unreadable.");
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (!isString(value)) throw new Error("Vault storage is unreadable.");
    result.set(key, value);
  }
  return result;
}

async function migrateLegacySnapshot(stateDir: string): Promise<void> {
  const locks = lockManager();
  if (!locks) throw new Error("Local credential locking is required.");
  await locks.request(
    "opensesame.retired-credentials",
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (!lock)
        throw new Error("A vault command is already running. Try again.");
      const records = await legacyRecords(stateDir);
      if (!records) return;
      for (const [key, value] of records) {
        await kvRefresh(
          key,
          Math.max(65536, new TextEncoder().encode(value).length),
        );
        // A damaged target raises above; an existing target always wins over an old snapshot.
        if (kvGet(key) === null) await kvSetDurable(key, value);
      }
      await kvFlush();
      await rename(
        join(stateDir, "vault-kv.json"),
        join(stateDir, "vault-kv.json.migrated"),
      );
    },
  );
}

/** Point the shared core at a durable Node host and hydrate locked-vault records. */
export async function useVaultKv(stateDir: string): Promise<void> {
  if (directory !== stateDir) {
    await releaseVaultKv();
    configureHost({
      ...createNodeHost({ stateDir }),
      capabilities: headlessCapabilityArtifacts,
      observationRuntime: "human-node-cli",
    });
    directory = stateDir;
  }
  await migrateLegacySnapshot(stateDir);
  await kvHydrate([
    TOMBS_REGISTRY_KEY,
    LEGACY_CONNECTOR_PUBLIC_KEY,
    ...DURESS_BOOT_KEYS,
  ]);
  await kvHydrate(listTombs().flatMap(tombStorageKeys));
}

/** Drain every write before changing host/key domains or simulating a new process. */
export async function releaseVaultKv(): Promise<void> {
  if (directory !== null) {
    const { vaultStore } = await import(
      "@opensesame/app-core/lib/vault/store.js"
    );
    vaultStore.lock();
  }
  await flushActivityLog();
  await vfsFlush();
  await kvFlush();
  directory = null;
  kvForgetAll();
}
