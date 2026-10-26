/** Retire only an invocation's large build inputs; keep its small audit evidence. */
import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

async function present(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writableDirectories(root) {
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    const info = await present(directory);
    if (!info?.isDirectory()) continue; // Never traverse a symlink into another task.
    // Go's module cache deliberately uses read-only directories. Their parent
    // directories must be writable to remove entries on Unix too.
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (entry.isDirectory()) pending.push(join(directory, entry.name));
  }
}

export async function cleanupNativeAuditScratch(work) {
  const output = join(work, "audit");
  for (const name of ["source", "compiler", "cache", "tmp", "audit-tools"]) {
    const path = join(output, name);
    await writableDirectories(path);
    await rm(path, { recursive: true, force: true });
  }
  // Download failures can leave large partial archives outside the build output.
  // Shared verified archives live elsewhere and are never part of this cleanup.
  for (const name of ["tmp", "source.download", "compiler.download"])
    await rm(join(work, name), { recursive: true, force: true });
}
