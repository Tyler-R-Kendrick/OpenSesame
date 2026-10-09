// The workspace packages a CI area's source reaches through production deps.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { isString } from "./json-boundary.mjs";

function workspaceGlobs(root) {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  return [...yaml.matchAll(/^\s*-\s*"([^"]+)"/gm)].map((match) => match[1]);
}

function packageDirs(root) {
  const dirs = [];
  for (const glob of workspaceGlobs(root)) {
    if (glob.endsWith("/*")) {
      const parent = join(root, glob.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(parent, entry.name);
        if (existsSync(join(dir, "package.json"))) dirs.push(dir);
      }
      continue;
    }
    const dir = join(root, glob);
    if (existsSync(join(dir, "package.json"))) dirs.push(dir);
  }
  return dirs;
}

/** Workspace packages reachable from `seeds` through production deps. */
export function packageDirsFrom(root, seeds) {
  const byName = new Map();
  for (const dir of packageDirs(root)) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (isString(pkg.name)) byName.set(pkg.name, { dir, pkg });
  }
  for (const seed of seeds) {
    if (!byName.has(seed)) throw new Error(`workspace has no ${seed} package`);
  }
  const seen = new Set();
  const queue = [...seeds];
  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    const entry = byName.get(name);
    if (!entry) continue;
    const fields = [entry.pkg.dependencies, entry.pkg.optionalDependencies];
    for (const field of fields) {
      for (const dep of Object.keys(field ?? {})) {
        if (byName.has(dep)) queue.push(dep);
      }
    }
  }
  return [...seen]
    .map((name) => relative(root, byName.get(name).dir).replaceAll("\\", "/"))
    .sort();
}

/** Workspace packages reachable from @opensesame/pages production deps. */
export const bundlePackageDirs = (root) =>
  packageDirsFrom(root, ["@opensesame/pages"]);

/**
 * What `verify:push` imports as source: the Identity API, the Host's Web Push
 * delivery, the adapters and their stand-in, and the repositories, with what
 * each depends on.
 */
export const pushPackageDirs = (root) =>
  packageDirsFrom(root, [
    "@opensesame/control-plane",
    "@opensesame/identity-worker",
    "@opensesame/notification-adapters",
    "@opensesame/database",
  ]);
