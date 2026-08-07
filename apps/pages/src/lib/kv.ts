/**
 * Same-origin KV with OPFS primary + in-memory fallback.
 * Never uses localStorage/sessionStorage (XSS-exfiltrable; banned by ast-grep).
 */

const memory = new Map<string, string>();

async function opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await navigator.storage?.getDirectory?.()) ?? null;
  } catch {
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
export function kvGet(key: string): string | null {
  return memory.get(key) ?? null;
}

/** Sync write to memory; async persist to OPFS when available. */
export function kvSet(key: string, value: string): void {
  memory.set(key, value);
  void opfsWrite(key, value).catch(() => {
    /* memory remains source of truth for the session */
  });
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

/** Load keys from OPFS into memory before first paint. */
export async function kvHydrate(keys: string[]): Promise<void> {
  await Promise.all(
    keys.map(async (key) => {
      const value = await opfsRead(key);
      if (value != null) memory.set(key, value);
    }),
  );
}
