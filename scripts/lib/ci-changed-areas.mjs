// Which heavy CI suites a pull-request diff has to run.
//
// The required check names (TypeScript, Bundle budgets, Rust) always
// report. A suite runs only when a changed path can affect it. Docs do
// not run a suite. A path this file does not recognize runs every suite:
// a wrong skip is worse than one extra run.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_GATES,
  bundleMatrix,
  driverReach,
  gatesForPaths,
  loadShards,
  relayJoinPath,
} from "./ci-gates.mjs";
import { bundlePackageDirs, pushPackageDirs } from "./ci-package-dirs.mjs";

export const AREAS = ["typescript", "bundle", "rust", "mtls", "push"];

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
  return { typescript: true, bundle: true, rust: true, mtls: true, push: true };
}

function blank() {
  return {
    typescript: false,
    bundle: false,
    rust: false,
    mtls: false,
    push: false,
  };
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

// What `verify:push` runs besides the Pages build: the walk, its stack and
// the capture harness that reuses the stack. The server code it exercises
// (control-plane, the push adapters and stand-in, the Host's delivery, the
// repositories) is found through the package graph, `pushPackageDirs`.
const PUSH_FILES = new Set([
  ".github/workflows/ci.yml",
  "apps/pages/scripts/verify-push.mjs",
  "apps/pages/scripts/build-workers.mjs",
  "apps/pages/scripts/lib/capture-harness.mjs",
  "apps/pages/scripts/lib/capture-push-steps.mjs",
  "apps/pages/vite.sw-push.config.ts",
  "tools/quality/bundle-budgets.json",
]);

function isPush(path, pushDirs) {
  if (pushDirs.some((dir) => under(path, dir))) return true;
  if (PUSH_FILES.has(path)) return true;
  if (path === "turbo.json" || NODE_INSTALL.has(path)) return true;
  return (
    path.startsWith("apps/pages/scripts/lib/push-") ||
    path.startsWith("packages/notification-adapters/")
  );
}

function mark(path, bundleDirs, pushDirs, out) {
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
  if (isPush(path, pushDirs)) {
    out.push = true;
    known = true;
  }
  return known;
}

/**
 * @param {string[]} paths
 * @param {string[]} bundleDirs
 * @param {string[]} pushDirs
 */
export function areasForPaths(paths, bundleDirs = [], pushDirs = []) {
  const out = blank();
  for (const raw of paths) {
    const path = normalizePath(raw);
    if (path === "" || isDoc(path)) continue;
    if (!mark(path, bundleDirs, pushDirs, out)) return everyArea();
  }
  return out;
}

export {
  bundlePackageDirs,
  packageDirsFrom,
  pushPackageDirs,
} from "./ci-package-dirs.mjs";

export function repoRootFromHere() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function emit(areas, gates = new Set(ALL_GATES)) {
  // Whatever goes wrong upstream, the default is every gate and every leg.
  const matrix = bundleMatrix(gates, loadShards(repoRootFromHere()));
  const lines = [
    ...AREAS.map((name) => {
      // The Web Push job runs for the server code it exercises (the `push`
      // area) and for the changes the gate rules send to it.
      const on =
        name === "push" ? areas.push || gates.has("push") : areas[name];
      return `${name}=${on ? "true" : "false"}`;
    }),
    // The bundle job's legs for this diff, as the workflow's matrix.
    `bundle_matrix=${JSON.stringify(matrix)}`,
    `tutorials=${gates.has("tutorials") ? "true" : "false"}`,
    `device_inbox=${gates.has("device-inbox") ? "true" : "false"}`,
    `device_identity=${gates.has("device-identity") ? "true" : "false"}`,
  ];
  const output = process.env.GITHUB_OUTPUT;
  if (output) writeFileSync(output, `${lines.join("\n")}\n`, { flag: "a" });
  for (const line of lines) console.log(line);
}

function changedPaths(root, base, head, filter) {
  const diff = execFileSync(
    "git",
    [
      "diff",
      "--name-only",
      ...(filter ? [`--diff-filter=${filter}`] : []),
      `${base}...${head}`,
    ],
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
  let dirs;
  let pushDirs;
  try {
    paths = changedPaths(root, base, head);
    dirs = bundlePackageDirs(root);
    pushDirs = pushPackageDirs(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `git diff or package graph failed, running every area: ${message}`,
    );
    emit(everyArea());
    return;
  }
  const areas = areasForPaths(paths, dirs, pushDirs);
  const ran = AREAS.filter((name) => areas[name]);
  const which = ran.length > 0 ? ran.join(" ") : "no heavy suite";
  console.error(`changed ${paths.length} path(s); ${which}`);
  let gates;
  try {
    gates = browserGates(root, base, head, dirs, pushDirs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A workflow annotation, so a fallback that costs a full run is not silent.
    console.error(
      `::warning::gate selection failed, running every gate: ${message}`,
    );
    gates = new Set(ALL_GATES);
  }
  console.error(`browser gates: ${[...gates].join(" ") || "none"}`);
  emit(areas, gates);
}

/**
 * The browser gates the diff has to run: what each added, modified or renamed
 * path in the Pages build's area can reach (ci-gates.mjs). A deleted path
 * selects nothing: whatever imported it changed in the same diff.
 */
function browserGates(root, base, head, dirs, pushDirs) {
  return selectGates(
    root,
    changedPaths(root, base, head, "ACMRT"),
    dirs,
    pushDirs,
  );
}

/** The gates for changed paths that are added, modified or renamed. */
export function selectGates(root, kept, dirs, pushDirs) {
  const inBundle = kept.filter(
    (path) =>
      path === ".github/workflows/ci.yml" ||
      relayJoinPath(path) ||
      areasForPaths([path], dirs, pushDirs).bundle,
  );
  const read = (path) => {
    const file = join(root, path);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };
  return gatesForPaths(inBundle, driverReach(root), read);
}

const invoked =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
