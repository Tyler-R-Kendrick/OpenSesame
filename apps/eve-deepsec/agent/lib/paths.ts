import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** OpenSesame repo root (parent of `apps/`). */
export const repoRoot = resolve(here, "../../../..");

export const deepsecRoot = join(repoRoot, ".deepsec");

export function assertInside(root: string, requested: string): string {
  const resolved = resolve(root, requested);
  const rel = relative(root, resolved);
  if (rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith("..")) {
    throw new Error(`path escapes ${root}: ${requested}`);
  }
  return resolved;
}

export function assertRepoFile(requested: string): string {
  const resolved = assertInside(repoRoot, requested);
  if (!existsSync(resolved)) {
    throw new Error(`not found: ${requested}`);
  }
  return resolved;
}
