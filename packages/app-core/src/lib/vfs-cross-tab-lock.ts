/** One cross-tab fence for a VFS read-modify-write. Tabs share OPFS files. */
import { lockManager } from "../ports.js";

export const VFS_REGISTRY_LOCK = "opensesame:vfs-tomb-registry";
export const VFS_INDEX_LOCK_PREFIX = "opensesame:vfs-index:";

/**
 * Web Locks where the host has them; a host without them keeps the old
 * single-document behavior. The callback runs under the lock, not around it.
 */
export function withVfsCrossTabLock<T>(
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  const locks = lockManager();
  return locks ? locks.request(name, work) : work();
}
