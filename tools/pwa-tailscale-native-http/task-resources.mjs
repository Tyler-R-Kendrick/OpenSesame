/** Bound this native task's owned storage, not unrelated software on the CI image. */
import { lstat, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";

export const NATIVE_TASK_DISK_LIMIT = 27n * 1024n ** 3n;
export const NATIVE_MINIMUM_FREE = 64n * 1024n ** 2n;

export function assertNativeResourceLimits(ownedBytes, availableBytes) {
  if (ownedBytes > NATIVE_TASK_DISK_LIMIT)
    throw new Error(
      "Native task exceeded its unchanged 27 GiB owned-storage limit.",
    );
  if (availableBytes < NATIVE_MINIMUM_FREE)
    throw new Error(
      "Native task has less than 64 MiB of available filesystem space.",
    );
}

/** Count allocated file/directory bytes once per inode; never follow a symlink out of the task. */
export async function nativeTaskStorage(root) {
  const initial = await lstat(root, { bigint: true });
  if (!initial.isDirectory() || initial.isSymbolicLink())
    throw new Error("Native task storage root must be an owned directory.");
  const pending = [root];
  const seen = new Set();
  let bytes = 0n;
  while (pending.length) {
    const directory = pending.shift();
    let entries;
    try {
      const current = await lstat(directory);
      if (!current.isDirectory() || current.isSymbolicLink()) continue;
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue;
      throw error;
    }
    const paths = [
      directory,
      ...entries
        .filter((entry) => !entry.isDirectory())
        .map((entry) => join(directory, entry.name)),
    ];
    for (let start = 0; start < paths.length; start += 16) {
      const values = await Promise.all(
        paths.slice(start, start + 16).map(async (path) => {
          try {
            return await lstat(path, { bigint: true });
          } catch (error) {
            if (error?.code === "ENOENT") return null;
            throw error;
          }
        }),
      );
      for (const value of values) {
        if (!value) continue;
        const inode = `${value.dev}:${value.ino}`;
        if (seen.has(inode)) continue;
        seen.add(inode);
        const allocated = value.blocks * 512n;
        bytes +=
          value.isFile() && value.size > allocated ? value.size : allocated;
        if (bytes > NATIVE_TASK_DISK_LIMIT)
          assertNativeResourceLimits(bytes, NATIVE_MINIMUM_FREE);
      }
    }
    for (const entry of entries)
      if (entry.isDirectory()) pending.push(join(directory, entry.name));
  }
  return bytes;
}

/** Filesystem availability and task ownership are independent resource checks. */
export async function assertNativeTaskResources(root) {
  const disk = await statfs(root, { bigint: true });
  const availableBytes = disk.bavail * disk.bsize;
  assertNativeResourceLimits(0n, availableBytes);
  const ownedBytes = await nativeTaskStorage(root);
  assertNativeResourceLimits(ownedBytes, availableBytes);
  return { ownedBytes, availableBytes, limitBytes: NATIVE_TASK_DISK_LIMIT };
}
