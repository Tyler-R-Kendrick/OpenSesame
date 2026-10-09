// Which packages and crates a pull-request diff has to test.
//
// The changed package or crate is tested together with everything that
// depends on it. Root manifests, lockfiles, and shared spec inputs test
// the whole suite. Docs, workflows, and repo scripts test neither.
// A diff that cannot be read tests everything.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isString } from "./json-boundary.mjs";

export const EXPERIENCE_PACKAGES = [
  "@opensesame/app-core",
  "@opensesame/pages",
  "@opensesame/oauth-provider",
  "@opensesame/control-plane",
  "@opensesame/database",
];

const LINT_PACKAGES = new Set(["@opensesame/pages", "@opensesame/static-auth"]);
const LINT_PATHS = new Set([
  "scripts/lib/static-auth-artifacts.test.mjs",
  "apps/pages/scripts/build-static-auth.mjs",
]);
const BITWARDEN = new Set([
  "opensesame-gateway",
  "opensesame-cli",
  "opensesame-bitwarden-server",
  "opensesame-provider-bitwarden",
  "opensesame-pm-bridges",
  "opensesame-kdbx-bridge",
]);
const PACKAGE_ALL = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
]);
const RUST_META = new Set(["clippy.toml", "deny.toml", "rustfmt.toml"]);
const EXTRA_SEEDS = [
  ["marketplace/item-types", "@opensesame/vault-item-types"],
  ["spec/conformance", "@opensesame/vault-core"],
  ["spec/connectors", "@opensesame/app-core"],
];
const NAME_OK = /^[@A-Za-z0-9][A-Za-z0-9._/-]*$/;
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

export function repoRootFromHere() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function normalize(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function isDoc(path) {
  if (path.endsWith(".md") || path === "LICENSE" || path.endsWith("/LICENSE")) {
    return true;
  }
  return ["docs", "skills", ".agents", ".claude"].some(
    (root) => path === root || path.startsWith(`${root}/`),
  );
}

function under(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function workspaceGlobs(root) {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  return [...yaml.matchAll(/^\s*-\s*"([^"]+)"/gm)].map((match) => match[1]);
}

function packageDirs(root) {
  const dirs = [];
  for (const glob of workspaceGlobs(root)) {
    if (!glob.endsWith("/*")) {
      if (existsSync(join(root, glob, "package.json")))
        dirs.push(join(root, glob));
      continue;
    }
    const parent = join(root, glob.slice(0, -2));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(parent, entry.name);
      if (existsSync(join(dir, "package.json"))) dirs.push(dir);
    }
  }
  return dirs;
}

function depNames(pkg) {
  const names = [];
  for (const field of DEP_FIELDS) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (NAME_OK.test(name)) names.push(name);
    }
  }
  return names;
}

/** @returns {{name: string, dir: string, deps: string[]}[]} */
export function loadPackageNodes(root) {
  const nodes = [];
  for (const dir of packageDirs(root)) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (!isString(pkg.name) || !NAME_OK.test(pkg.name)) continue;
    nodes.push({
      name: pkg.name,
      dir: relative(root, dir).replaceAll("\\", "/"),
      deps: depNames(pkg),
    });
  }
  return nodes;
}

function memberDirs(root) {
  const text = readFileSync(join(root, "Cargo.toml"), "utf8");
  const block = text.split("members = [")[1]?.split("]")[0] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function crateName(text) {
  const header = text.split(/\n\[/)[0] ?? text;
  return header.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

function crateDeps(text) {
  const matches = text.matchAll(
    /^\s*(opensesame-[\w-]+)\s*(?:\.workspace\s*)?=/gm,
  );
  return [...matches].map((match) => match[1]);
}

/** @returns {{name: string, dir: string, deps: string[]}[]} */
export function loadCrateNodes(root) {
  const nodes = [];
  for (const dir of memberDirs(root)) {
    const file = join(root, dir, "Cargo.toml");
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const name = crateName(text);
    if (!name || !NAME_OK.test(name)) continue;
    nodes.push({ name, dir, deps: crateDeps(text) });
  }
  return nodes;
}

function dependentsOf(nodes) {
  const known = new Set(nodes.map((node) => node.name));
  const map = new Map();
  for (const node of nodes) {
    for (const dep of node.deps) {
      if (!known.has(dep) || dep === node.name) continue;
      const list = map.get(dep) ?? [];
      list.push(node.name);
      map.set(dep, list);
    }
  }
  return map;
}

function close(seeds, dependents) {
  const seen = new Set();
  const queue = [...seeds];
  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    for (const next of dependents.get(name) ?? []) queue.push(next);
  }
  return [...seen].sort();
}

function owner(path, nodes) {
  let found = null;
  for (const node of nodes) {
    if (!under(path, node.dir)) continue;
    if (!found || node.dir.length > found.dir.length) found = node;
  }
  return found?.name ?? null;
}

function packageOpensAll(path) {
  if (PACKAGE_ALL.has(path)) return true;
  if (path.includes("/")) return false;
  return path === "tsconfig.json" || path.startsWith("tsconfig.");
}

function extraSeed(path, known) {
  for (const [prefix, name] of EXTRA_SEEDS) {
    if (under(path, prefix) && known.has(name)) return name;
  }
  return null;
}

function packageResult(scope, packages, lintPath) {
  const listed = scope === "packages" ? packages : [];
  const verifyPackages =
    scope === "packages"
      ? EXPERIENCE_PACKAGES.filter((name) => listed.includes(name))
      : [];
  const lintPackages = listed.some((name) => LINT_PACKAGES.has(name));
  return {
    scope,
    packages: listed,
    verifyExperience: scope === "all" || verifyPackages.length > 0,
    verifyPackages,
    lintArtifacts: scope === "all" || lintPath || lintPackages,
    bitwarden: false,
  };
}

/** @param {string[]} paths @param {{name: string, dir: string, deps: string[]}[]} nodes */
export function planPackages(paths, nodes) {
  const known = new Set(nodes.map((node) => node.name));
  let all = false;
  let lint = false;
  const seeds = new Set();
  for (const raw of paths) {
    const path = normalize(raw);
    if (path === "" || isDoc(path)) continue;
    if (LINT_PATHS.has(path)) lint = true;
    if (packageOpensAll(path)) {
      all = true;
      continue;
    }
    const name = owner(path, nodes) ?? extraSeed(path, known);
    if (name) seeds.add(name);
  }
  if (all) return packageResult("all", [], true);
  const packages = close(seeds, dependentsOf(nodes));
  const scope = packages.length > 0 ? "packages" : "none";
  return packageResult(scope, packages, lint);
}

function cargoOpensAll(path) {
  if (path === "Cargo.toml" || path === "Cargo.lock") return true;
  if (path === "rust-toolchain" || path === "rust-toolchain.toml") return true;
  if (under(path, ".cargo") || under(path, "marketplace/item-types"))
    return true;
  return under(path, "spec");
}

function rustish(path) {
  if (path.endsWith(".rs")) return true;
  if (path.endsWith("/Cargo.toml") || path.endsWith("/Cargo.lock")) return true;
  if (RUST_META.has(path)) return true;
  return path.startsWith("crates/") || path.startsWith("apps/cli/");
}

function considerCrate(path, nodes) {
  if (cargoOpensAll(path)) return "all";
  if (under(path, "tests/fuzz/cargo")) return "skip";
  const name = owner(path, nodes);
  if (name) return name;
  return rustish(path) ? "all" : "skip";
}

function crateResult(scope, packages) {
  const listed = scope === "packages" ? packages : [];
  const bitwarden =
    scope === "all" || listed.some((name) => BITWARDEN.has(name));
  return {
    scope,
    packages: listed,
    verifyExperience: false,
    verifyPackages: [],
    lintArtifacts: false,
    bitwarden,
  };
}

/** @param {string[]} paths @param {{name: string, dir: string, deps: string[]}[]} nodes */
export function planCrates(paths, nodes) {
  let all = false;
  const seeds = new Set();
  for (const raw of paths) {
    const path = normalize(raw);
    if (path === "" || isDoc(path)) continue;
    const hit = considerCrate(path, nodes);
    if (hit === "all") all = true;
    else if (hit !== "skip") seeds.add(hit);
  }
  if (all) return crateResult("all", []);
  const packages = close(seeds, dependentsOf(nodes));
  const scope = packages.length > 0 ? "packages" : "none";
  return crateResult(scope, packages);
}

export function fallbackPlan(kind) {
  if (kind === "cargo") return crateResult("all", []);
  return packageResult("all", [], true);
}
