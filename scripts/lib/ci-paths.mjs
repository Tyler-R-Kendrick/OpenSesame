// Path helpers shared by the CI classifiers (ci-changed-areas.mjs and
// ci-deep-gates.mjs): one place that says what a path is, never what it runs.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DOC_ROOTS = ["docs", "skills", ".agents", ".claude"];

export function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function under(path, prefix) {
  const root = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return path === root || path.startsWith(`${root}/`);
}

export function anyUnder(path, prefixes) {
  return prefixes.some((prefix) => under(path, prefix));
}

export function baseName(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function isDoc(path) {
  if (path.endsWith(".md")) return true;
  if (anyUnder(path, DOC_ROOTS)) return true;
  return baseName(path) === "LICENSE";
}

export function repoRootFromHere() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}
