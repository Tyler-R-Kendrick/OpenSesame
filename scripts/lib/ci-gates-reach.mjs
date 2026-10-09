// Which drivers reach each script module under apps/pages/scripts.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ALL_GATES, DRIVER_GATES } from "./ci-gates-drivers.mjs";

const SCRIPTS = "apps/pages/scripts";
const IMPORT = /(?:from\s*|import\s*\(\s*|import\s+)["'](\.[^"']+)["']/g;

function readIfThere(root, path) {
  const file = join(root, path);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function resolveRelative(from, spec) {
  const parts = from.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}

function rootGates(name) {
  if (name.startsWith("verify-")) {
    return name in DRIVER_GATES ? (DRIVER_GATES[name] ?? []) : ALL_GATES;
  }
  if (name.startsWith("capture-")) return [];
  return ALL_GATES;
}

/** Which drivers reach each script module, by following relative imports. */
export function driverReach(root) {
  const dirs = [SCRIPTS, `${SCRIPTS}/lib`];
  const files = dirs.flatMap((dir) => {
    const at = join(root, dir);
    return existsSync(at)
      ? readdirSync(at)
          .filter((name) => name.endsWith(".mjs"))
          .map((name) => `${dir}/${name}`)
      : [];
  });
  const edges = new Map();
  for (const file of files) {
    const targets = [];
    for (const match of readIfThere(root, file).matchAll(IMPORT)) {
      targets.push(resolveRelative(file, match[1]));
    }
    edges.set(file, targets);
  }
  const reach = new Map();
  const roots = files.filter(
    (file) => file.startsWith(`${SCRIPTS}/`) && !file.includes("/lib/"),
  );
  for (const start of roots) {
    const stands = rootGates(start.slice(SCRIPTS.length + 1));
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      const next = queue.pop();
      for (const target of edges.get(next) ?? []) {
        if (!seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
    for (const file of seen) {
      if (!reach.has(file)) reach.set(file, new Set());
      for (const gate of stands) reach.get(file).add(gate);
    }
  }
  for (const file of files) if (!reach.has(file)) reach.set(file, new Set());
  return reach;
}

/** The gates a changed script of apps/pages/scripts can change. */
export function scriptGates(path, reach) {
  const name = path.slice(SCRIPTS.length + 1);
  if (name.startsWith("verify-") && !(name in DRIVER_GATES)) {
    return new Set(ALL_GATES);
  }
  const reached = reach.get(path);
  if (reached === undefined) {
    return /\.m?js$/.test(path) ? new Set() : new Set(ALL_GATES);
  }
  return new Set(reached);
}
