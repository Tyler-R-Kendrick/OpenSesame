import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * The directory of the copy of `name` that a workspace member resolves, found
 * through Node's own resolution from the member's package.json. A config that
 * names `<member>/node_modules/<name>` holds only under pnpm's isolated
 * layout; this holds under any node_modules layout: the member's own copy, a
 * hoisted copy at the root, or a copy nested under the member because the
 * root's does not satisfy it.
 */
export function dependencyRoot(memberPackageJson, name) {
  const entry = createRequire(memberPackageJson).resolve(name);
  for (let dir = dirname(entry); dirname(dir) !== dir; dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && manifestName(manifest) === name) return dir;
  }
  throw new Error(`${name} resolves to ${entry}, outside any package root`);
}

function manifestName(path) {
  const { name } = JSON.parse(readFileSync(path, "utf8"));
  return name;
}
