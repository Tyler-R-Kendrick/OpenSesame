// Which heavy CI suites a pull-request diff has to run.
//
// The required check names (TypeScript, Bundle budgets, Rust) always
// report. A suite runs only when a changed path can affect it. Docs do
// not run a suite. A path this file does not recognize runs every suite:
// a wrong skip is worse than one extra run.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isString } from "./json-boundary.mjs";

export const AREAS = ["typescript", "bundle", "rust", "mtls"];

const DOC_ROOTS = ["docs", "skills", ".agents", ".claude"];
const RUST_ROOTS = [
  "crates",
  "apps/cli",
  ".cargo",
  "marketplace/item-types",
  "spec/wit",
  "spec/conformance",
  "tests/fuzz/cargo",
  "tests/mtls-interop",
];
const RUST_FILES = new Set([
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain",
  "rust-toolchain.toml",
  "spec/connectors/catalog.json",
  "spec/openapi/host-api.yaml",
]);
// Crates and packages the mTLS job actually executes (scripts/mtls/*).
// Gateway is included whole: its only ignored live test sits under
// src/routes, and the job runs that test whenever the transport tree exists.
const MTLS_ROOTS = [
  "scripts/mtls",
  "tests/mtls-interop",
  "ops/ingress",
  "ops/nats",
  "crates/domain",
  "crates/transport-security",
  "crates/spiffe-source",
  "crates/ingress-evidence",
  "crates/nats-callout",
  "crates/task-bus",
  "crates/provider-openbao",
  "crates/gateway",
  "packages/os-domain",
  "packages/contracts",
  "packages/oauth-provider",
  "packages/ingress-evidence",
  "packages/control-plane/src/transport",
  "apps/pages/src/sections/settings/transport",
];
const MTLS_FILES = new Set([
  "apps/pages/scripts/verify-transport.mjs",
  "apps/pages/scripts/verify-browser-cert.mjs",
]);
const TS_ROOTS = [
  "packages",
  "examples",
  "tools",
  "scripts",
  "tests/redteam",
  "tests/visual-contract",
  "tests/fuzz/jazzer",
  "marketplace",
  ".github/workflows",
  ".githooks",
];
const TS_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"];
const TS_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
  "biome.json",
]);
const NODE_INSTALL = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
]);

export function everyArea() {
  return { typescript: true, bundle: true, rust: true, mtls: true };
}

function blank() {
  return { typescript: false, bundle: false, rust: false, mtls: false };
}

export function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function under(path, prefix) {
  const root = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return path === root || path.startsWith(`${root}/`);
}

function anyUnder(path, prefixes) {
  return prefixes.some((prefix) => under(path, prefix));
}

function baseName(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isDoc(path) {
  if (path.endsWith(".md")) return true;
  if (anyUnder(path, DOC_ROOTS)) return true;
  return baseName(path) === "LICENSE";
}

function isRust(path) {
  if (path.endsWith(".rs")) return true;
  if (RUST_FILES.has(baseName(path)) || RUST_FILES.has(path)) return true;
  return anyUnder(path, RUST_ROOTS);
}

function transportLeaf(path, dir) {
  if (!path.startsWith(`${dir}/`)) return false;
  const rest = path.slice(dir.length + 1);
  return (
    rest === "transport" ||
    rest.startsWith("transport/") ||
    rest.startsWith("transport-")
  );
}

function isMtls(path) {
  if (path === "Cargo.toml" || path === "Cargo.lock") return true;
  if (NODE_INSTALL.has(path)) return true;
  if (MTLS_FILES.has(path)) return true;
  if (anyUnder(path, MTLS_ROOTS)) return true;
  // transport-status.ts and transport-journey.mjs sit beside other files.
  return (
    transportLeaf(path, "packages/app-core/src/lib") ||
    transportLeaf(path, "apps/pages/scripts") ||
    transportLeaf(path, "apps/pages/scripts/lib")
  );
}

function isTypescript(path) {
  if (under(path, "apps") && !under(path, "apps/cli")) return true;
  if (anyUnder(path, TS_ROOTS)) return true;
  if (TS_EXT.some((ext) => path.endsWith(ext))) return true;
  if (TS_FILES.has(path)) return true;
  if (
    path.endsWith("/tsconfig.json") ||
    baseName(path).startsWith("tsconfig.")
  ) {
    return true;
  }
  if (path === "spec/connectors/catalog.json") return true;
  if (path === "spec/openapi/host-api.yaml") return true;
  if (under(path, "spec/conformance") || under(path, "spec/wit")) return true;
  return false;
}

function isBundle(path, bundleDirs) {
  if (bundleDirs.some((dir) => under(path, dir))) return true;
  if (path === "tools/quality/bundle-budgets.json") return true;
  if (path === "turbo.json" || NODE_INSTALL.has(path)) return true;
  return under(path, "marketplace/item-types");
}

function mark(path, bundleDirs, out) {
  let known = false;
  if (isRust(path)) {
    out.rust = true;
    known = true;
  }
  if (isMtls(path)) {
    out.mtls = true;
    known = true;
  }
  if (isTypescript(path)) {
    out.typescript = true;
    known = true;
  }
  if (isBundle(path, bundleDirs)) {
    out.bundle = true;
    known = true;
  }
  return known;
}

/** @param {string[]} paths @param {string[]} bundleDirs */
export function areasForPaths(paths, bundleDirs = []) {
  const out = blank();
  for (const raw of paths) {
    const path = normalizePath(raw);
    if (path === "" || isDoc(path)) continue;
    if (!mark(path, bundleDirs, out)) return everyArea();
  }
  return out;
}

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

/** Workspace packages reachable from @opensesame/pages production deps. */
export function bundlePackageDirs(root) {
  const byName = new Map();
  for (const dir of packageDirs(root)) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (isString(pkg.name)) byName.set(pkg.name, { dir, pkg });
  }
  if (!byName.has("@opensesame/pages")) {
    throw new Error("workspace has no @opensesame/pages package");
  }
  const seen = new Set();
  const queue = ["@opensesame/pages"];
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

export function repoRootFromHere() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function emit(areas) {
  const lines = AREAS.map(
    (name) => `${name}=${areas[name] ? "true" : "false"}`,
  );
  const output = process.env.GITHUB_OUTPUT;
  if (output) writeFileSync(output, `${lines.join("\n")}\n`, { flag: "a" });
  for (const line of lines) console.log(line);
}

function changedPaths(root, base, head) {
  const diff = execFileSync(
    "git",
    ["diff", "--name-only", `${base}...${head}`],
    { encoding: "utf8", cwd: root },
  );
  return diff.split("\n").filter(Boolean);
}

function main() {
  const base = process.env.BASE_SHA ?? "";
  const head = process.env.HEAD_SHA ?? "";
  const root = repoRootFromHere();
  if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head)) {
    console.error(
      "BASE_SHA and HEAD_SHA must be commit shas; running every area",
    );
    emit(everyArea());
    return;
  }
  let paths;
  try {
    paths = changedPaths(root, base, head);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`git diff failed, running every area: ${message}`);
    emit(everyArea());
    return;
  }
  let dirs;
  try {
    dirs = bundlePackageDirs(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`package graph failed, running every area: ${message}`);
    emit(everyArea());
    return;
  }
  const areas = areasForPaths(paths, dirs);
  const ran = AREAS.filter((name) => areas[name]);
  const which = ran.length > 0 ? ran.join(" ") : "no heavy suite";
  console.error(`changed ${paths.length} path(s); ${which}`);
  emit(areas);
}

const invoked =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
