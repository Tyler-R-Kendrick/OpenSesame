import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** OpenSesame repo root (parent of `apps/`). */
export const repoRoot = resolve(here, "../../../..");

export const deepsecRoot = join(repoRoot, ".deepsec");

export function assertInside(root: string, requested: string): string {
  const resolved = resolve(root, requested);
  if (!existsSync(resolved)) {
    throw new Error(`not found: ${requested}`);
  }
  const canonicalRoot = realpathSync(root);
  const canonical = realpathSync(resolved);
  const rel = relative(canonicalRoot, canonical);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error(`path escapes ${root}: ${requested}`);
  }
  return canonical;
}

export function assertRepoFile(requested: string): string {
  return assertInside(repoRoot, requested);
}
