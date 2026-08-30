/**
 * Same-origin KV with OPFS primary + in-memory fallback.
 * Never uses localStorage/sessionStorage (XSS-exfiltrable; banned by ast-grep).
 *
 * This is the flat transport layer. The encrypted VFS (`lib/vfs.ts`,
 * ADR 0063) builds the tomb namespace on top: every vault is a tomb
 * (`tomb/<name>/…`, the personal vault is the `personal` tomb, ADR 0038),
 * sealed content under the tomb's vault key, with only the documented
 * plaintext boundary (boot endpoints, vault header params, lockout
 * counters, tomb names) stored unsealed.
 */

const memory = new Map<string, string>();

/**
 * Whether writes can outlive the tab. "unknown" until something touches OPFS —
 * `kvHydrate` settles it before first paint.
 */
export type KvDurability = "unknown" | "persistent" | "memory";

let durability: KvDurability = "unknown";

/**
 * Reported so callers can say plainly that nothing will survive a reload rather
 * than let a successful write imply it was saved.
 */
export function kvDurability(): KvDurability {
  return durability;
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = (await navigator.storage?.getDirectory?.()) ?? null;
    durability = root ? "persistent" : "memory";
    return root;
  } catch {
    durability = "memory";
    return null;
  }
}

function fileName(key: string): string {
  return `opensesame-pages-${key.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

async function opfsRead(key: string): Promise<string | null> {
  try {
    const root = await opfsRoot();
    if (!root) return null;
    const handle = await root.getFileHandle(fileName(key));
    const file = await handle.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

async function opfsWrite(key: string, value: string): Promise<void> {
  const root = await opfsRoot();
  if (!root) return;
  const handle = await root.getFileHandle(fileName(key), { create: true });
  const writable = await handle.createWritable();
  await writable.write(value);
  await writable.close();
}

/** Sync read from hydrated memory. */
function kvGetDefault(key: string): string | null {
  return memory.get(key) ?? null;
}

/**
 * Sync write to memory; async persist to OPFS when available. Failures are
 * swallowed: memory is the source of truth for the session. Use `kvSetDurable`
 * wherever losing the write would mean losing the only copy of something.
 */
export function kvSet(key: string, value: string): void {
  memory.set(key, value);
  void opfsWrite(key, value).catch(() => {
    /* memory remains source of truth for the session */
  });
}

/**
 * Write to memory and wait for OPFS to accept it, rejecting if it does not, so
 * the caller can undo its change rather than believe it was saved. Memory is
 * left holding the previous value on failure, matching what survives a reload.
 *
 * Where OPFS is absent altogether this resolves — refusing would leave the app
 * unusable in that browser. `kvDurability()` reports which case you are in, and
 * the vault says so on screen.
 */
async function kvSetDurableDefault(key: string, value: string): Promise<void> {
  const previous = memory.get(key);
  memory.set(key, value);
  try {
    await opfsWrite(key, value);
  } catch (error) {
    if (previous === undefined) memory.delete(key);
    else memory.set(key, previous);
    throw error;
  }
}

export const kvSeams = {
  kvGet: kvGetDefault,
  kvSetDurable: kvSetDurableDefault,
};

export function kvGet(key: string): string | null {
  return kvSeams.kvGet(key);
}

export async function kvSetDurable(key: string, value: string): Promise<void> {
  return kvSeams.kvSetDurable(key, value);
}

export function kvDelete(key: string): void {
  memory.delete(key);
  void (async () => {
    try {
      const root = await opfsRoot();
      if (!root) return;
      await root.removeEntry(fileName(key));
    } catch {
      /* ignore */
    }
  })();
}

/**
 * Remove a key and wait for OPFS to forget it, so a caller can tell the user it
 * is gone rather than that it has been asked to go. Absent already counts as
 * gone; anything else is reported.
 */
export async function kvDeleteDurable(key: string): Promise<void> {
  memory.delete(key);
  const root = await opfsRoot();
  if (!root) return;
  try {
    await root.removeEntry(fileName(key));
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return;
    throw error;
  }
}

/** Load keys from OPFS into memory before first paint. */
export async function kvHydrate(keys: string[]): Promise<void> {
  // Settle durability even with nothing to load, so the first render already
  // knows whether anything written here can survive a reload.
  await opfsRoot();
  await Promise.all(
    keys.map(async (key) => {
      const value = await opfsRead(key);
      if (value != null) memory.set(key, value);
    }),
  );
}
