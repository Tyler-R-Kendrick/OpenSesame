/**
 * The Pages vault is a sealed virtual filesystem, and Node has no OPFS. The CLI
 * keeps it as real files in the state directory (ADR 0182): every secret is a
 * file under `<state>/vault/<tomb>/secrets/`, named for the secret and its
 * folder, so a vault can be listed, diffed, backed up, shared by file or locked
 * down with the tools already on the machine. The layout, the sealing and the
 * retry policy are the shared core's (`@opensesame/app-core`); this file only
 * chooses the directory and moves over a vault an older CLI left in
 * `vault-kv.json`.
 */
import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { flushActivityLog } from "@opensesame/app-core/lib/activity-log.js";
import { kvForgetAll } from "@opensesame/app-core/lib/kv.js";
import { vfsFlush, vfsSeams } from "@opensesame/app-core/lib/vfs.js";
import {
  type VaultDirectory,
  useVaultDirectory,
} from "@opensesame/app-core/node/vault-directory.js";
import { isJsonObject, isString, overlapCast } from "@opensesame/os-domain";

/** Where the vault's files are, under the state directory. */
export const VAULT_DIRECTORY = "vault";
const LEGACY_SNAPSHOT = "vault-kv.json";
const MIGRATED_SNAPSHOT = "vault-kv.json.migrated";

let current: { stateDir: string; directory: VaultDirectory } | null = null;

function isEnoent(error: Error): boolean {
  return "code" in error && error.code === "ENOENT";
}

/** What the previous CLI kept: every VFS record in one JSON file. */
async function readLegacySnapshot(
  stateDir: string,
): Promise<Map<string, string> | null> {
  let text: string;
  try {
    text = await readFile(join(stateDir, LEGACY_SNAPSHOT), "utf8");
  } catch (error) {
    if (error instanceof Error && isEnoent(error)) return null;
    throw error;
  }
  const parsed = overlapCast(JSON.parse(text));
  if (!isJsonObject(parsed)) throw new Error("Vault storage is unreadable.");
  const records = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (!isString(value)) throw new Error("Vault storage is unreadable.");
    records.set(key, value);
  }
  return records;
}

/**
 * Move a vault from the single-file snapshot into files. It is kept beside the
 * new directory as `vault-kv.json.migrated`: the same ciphertext it always
 * was, and a way back until the person removes it.
 */
async function migrateLegacySnapshot(stateDir: string): Promise<void> {
  const legacy = await readLegacySnapshot(stateDir);
  if (legacy === null) return;
  // A directory that already holds a vault is the vault; the old file is left alone.
  if (vfsSeams.readRaw("tombs.v1") !== null) return;
  // The registry last: a migration cut short leaves no vault that claims to be one.
  const ordered = [...legacy].sort(
    ([a], [b]) => Number(a === "tombs.v1") - Number(b === "tombs.v1"),
  );
  for (const [key, value] of ordered) await vfsSeams.writeRaw(key, value);
  await rename(
    join(stateDir, LEGACY_SNAPSHOT),
    join(stateDir, MIGRATED_SNAPSHOT),
  );
}

/** Notes fired during a command finish before the directory is closed or swapped. */
async function drainDurableWrites(): Promise<void> {
  await flushActivityLog();
  await vfsFlush();
}

/** Point the vault at this state directory's files and load them. */
export async function useVaultKv(stateDir: string): Promise<void> {
  if (current?.stateDir === stateDir) return;
  await releaseVaultKv();
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const directory = await useVaultDirectory(join(stateDir, VAULT_DIRECTORY));
  current = { stateDir, directory };
  kvForgetAll();
  await migrateLegacySnapshot(stateDir);
}

/** Close the directory so the next open reads the files again. */
export async function releaseVaultKv(): Promise<void> {
  if (current === null) return;
  const { directory } = current;
  await drainDurableWrites();
  directory.close();
  current = null;
  kvForgetAll();
}
