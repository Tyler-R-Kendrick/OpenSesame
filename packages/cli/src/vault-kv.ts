/**
 * The Pages vault is a sealed virtual filesystem. Node has no OPFS, so those
 * records would otherwise forget the vault when the process exits. The CLI
 * keeps the same records in the state directory.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { flushActivityLog } from "@opensesame/app-core/lib/activity-log.js";
import { kvForgetAll } from "@opensesame/app-core/lib/kv.js";
import { vfsFlush, vfsSeams } from "@opensesame/app-core/lib/vfs.js";
import { isJsonObject, isString, overlapCast } from "@opensesame/os-domain";

const FILE_NAME = "vault-kv.json";

/** What the store reads from disk through; a suite holds a read open here. */
export const vaultKvSeams = {
  readText: (path: string): Promise<string> => readFile(path, "utf8"),
};

let directory: string | null = null;
let records = new Map<string, string>();
let pending = Promise.resolve();
let installed = false;
// A released store is a closed process. Notes that land after release must
// not snapshot the cleared map over the file the next open is reading.
let accepting = true;
let readMemory: (key: string) => string | null = vfsSeams.readRaw;
let deleteMemory: (key: string) => Promise<void> = vfsSeams.deleteRaw;

function filePath(dir: string): string {
  return join(dir, FILE_NAME);
}

function isEnoent(error: Error): boolean {
  return "code" in error && error.code === "ENOENT";
}

async function readRecords(dir: string): Promise<Map<string, string>> {
  let text: string;
  try {
    text = await vaultKvSeams.readText(filePath(dir));
  } catch (error) {
    if (error instanceof Error && isEnoent(error)) return new Map();
    throw error;
  }
  const parsed = overlapCast(JSON.parse(text));
  if (!isJsonObject(parsed)) throw new Error("Vault storage is unreadable.");
  const next = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (!isString(value)) throw new Error("Vault storage is unreadable.");
    next.set(key, value);
  }
  return next;
}

async function writeSnapshot(
  dir: string | null,
  snapshot: ReadonlyMap<string, string>,
): Promise<void> {
  if (dir === null) return;
  const path = filePath(dir);
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(Object.fromEntries(snapshot)), {
    mode: 0o600,
  });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

function enqueueWrite(): Promise<void> {
  if (!accepting || directory === null) return Promise.resolve();
  const dir = directory;
  const snapshot = new Map(records);
  const write = () => writeSnapshot(dir, snapshot);
  pending = pending.then(write, write);
  return pending;
}

function installSeams(): void {
  if (!installed) {
    readMemory = vfsSeams.readRaw;
    deleteMemory = vfsSeams.deleteRaw;
    installed = true;
  }
  vfsSeams.readRaw = (key) => records.get(key) ?? readMemory(key);
  vfsSeams.writeRaw = async (key, value) => {
    if (!accepting || directory === null) return;
    records.set(key, value);
    await enqueueWrite();
  };
  vfsSeams.deleteRaw = async (key) => {
    if (!accepting || directory === null) return;
    records.delete(key);
    await deleteMemory(key);
    await enqueueWrite();
  };
}

/** Notes fired during a command finish before the file is closed or swapped. */
async function drainDurableWrites(): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await flushActivityLog();
    await vfsFlush();
    const current = pending;
    await current;
    if (pending === current) return;
  }
}

/** Point KV at this state directory and load the vault file into it. */
export async function useVaultKv(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  if (directory !== stateDir) {
    await drainDurableWrites();
    accepting = false;
    await pending;
    const loaded = await readRecords(stateDir);
    directory = stateDir;
    records = loaded;
    accepting = true;
    kvForgetAll();
  }
  installSeams();
}

/** Forget the in-memory copy so the next open reads the file again. */
export async function releaseVaultKv(): Promise<void> {
  await drainDurableWrites();
  accepting = false;
  await pending;
  directory = null;
  records = new Map();
  kvForgetAll();
}
