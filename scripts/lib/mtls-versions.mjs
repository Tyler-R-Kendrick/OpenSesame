/**
 * Resolved toolchain / library / fixture versions for the mTLS manifest.
 *
 * Everything here is read from the checkout (lockfiles, the fixture pins in
 * scripts/mtls/mtls-fixtures.sh) or from `<tool> --version`; nothing is guessed.
 * A tool that is not installed is reported as `null`, never as a version.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CARGO_PACKAGES = [
  "rustls",
  "tokio-rustls",
  "rustls-webpki",
  "rustls-pki-types",
  "async-nats",
  "nkeys",
  "spiffe",
  "spiffe-rustls",
  "rcgen",
  "x509-parser",
  "reqwest",
  "axum",
  "hyper",
];
const NPM_PACKAGES = [
  "oidc-provider",
  "hono",
  "@hono/node-server",
  "jose",
  "@playwright/test",
  "vitest",
  "structured-headers",
];

function run(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    }).trim();
  } catch {
    return null;
  }
}

function firstLine(s) {
  return s ? s.split("\n")[0].trim() : null;
}

/** Every version of `name` in Cargo.lock (a workspace may pin two). */
export function cargoLockVersions(lockText, name) {
  const re = new RegExp(
    `\\[\\[package\\]\\]\\nname = "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\nversion = "([^"]+)"`,
    "g",
  );
  const out = [];
  for (const m of lockText.matchAll(re)) out.push(m[1]);
  return out;
}

/** Every resolved version of `name` in pnpm-lock.yaml's `packages:` section. */
export function pnpmLockVersions(lockText, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `^  '?${esc}@([0-9][^'(:\\s]*)'?(?:\\([^)]*\\))?:`,
    "gm",
  );
  const out = new Set();
  for (const m of lockText.matchAll(re)) out.add(m[1]);
  return [...out];
}

/** Pinned fixture versions straight from `mtls-fixtures.sh list`. */
export function fixtureVersions(root) {
  const table = run(
    "bash",
    [join(root, "scripts/mtls/mtls-fixtures.sh"), "list"],
    root,
  );
  const out = {};
  if (!table) return out;
  const [header, ...rows] = table.split("\n");
  const cols = header.split("\t");
  const iTool = cols.indexOf("tool");
  const iVer = cols.indexOf("version");
  const iA = cols.indexOf("archive_sha256");
  for (const row of rows) {
    const f = row.split("\t");
    if (f.length <= Math.max(iTool, iVer, iA)) continue;
    out[f[iTool]] = { version: f[iVer], archive_sha256: f[iA] };
  }
  return out;
}

export function collectVersions(root) {
  const cargoLock = readFileSync(join(root, "Cargo.lock"), "utf8");
  const pnpmLock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  const cargo = {};
  for (const name of CARGO_PACKAGES) {
    const v = cargoLockVersions(cargoLock, name);
    cargo[name] = v.length === 0 ? null : v.join(",");
  }
  const npm = {};
  for (const name of NPM_PACKAGES) {
    const v = pnpmLockVersions(pnpmLock, name);
    npm[name] = v.length === 0 ? null : v.join(",");
  }
  return {
    rustc: firstLine(run("rustc", ["+1.88.0", "--version"], root)),
    cargo: firstLine(run("cargo", ["+1.88.0", "--version"], root)),
    node: firstLine(run("node", ["--version"], root)),
    pnpm: firstLine(run("pnpm", ["--version"], root)),
    chromium: process.env.PLAYWRIGHT_CHROMIUM
      ? firstLine(run(process.env.PLAYWRIGHT_CHROMIUM, ["--version"], root))
      : null,
    cargo_lock: cargo,
    pnpm_lock: npm,
    fixtures: fixtureVersions(root),
  };
}
