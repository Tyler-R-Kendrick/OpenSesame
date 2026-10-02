/** Web Lock and OPFS refresh for VFS read-modify-write metadata. */
import { lockManager } from "../ports.js";
import { kvDurability, kvRefresh } from "./kv.js";

export const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const tombWriteChains = new Map<string, Promise<unknown>>();
let registryWriteChain: Promise<unknown> = Promise.resolve();

async function withSharedWrite<T>(
  name: string,
  key: string,
  limit: number,
  op: () => Promise<T>,
): Promise<T> {
  const locks = lockManager();
  if (locks)
    return locks.request(name, async () => {
      await kvRefresh(key, limit);
      return op();
    });
  await kvRefresh(key, limit);
  if (kvDurability() === "persistent")
    throw new Error("Web Locks are required for shared vault writes.");
  return op();
}

export function enqueueTombWrite<T>(
  tomb: string,
  indexKey: string,
  op: () => Promise<T>,
): Promise<T> {
  const run = (tombWriteChains.get(tomb) ?? Promise.resolve()).then(() =>
    withSharedWrite(`opensesame:vfs:${tomb}`, indexKey, MAX_INDEX_BYTES, op),
  );
  tombWriteChains.set(
    tomb,
    run.catch(() => undefined),
  );
  return run;
}

export function enqueueRegistryWrite<T>(
  registryKey: string,
  op: () => Promise<T>,
): Promise<T> {
  const run = registryWriteChain.then(() =>
    withSharedWrite(
      "opensesame:vfs:registry",
      registryKey,
      MAX_REGISTRY_BYTES,
      op,
    ),
  );
  registryWriteChain = run.catch(() => undefined);
  return run;
}

export async function vfsFlush(): Promise<void> {
  await Promise.all([...tombWriteChains.values(), registryWriteChain]);
}
