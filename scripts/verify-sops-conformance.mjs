#!/usr/bin/env node
/**
 * Hermetic sops v3.13.3 conformance. Incomplete when the pinned oracle
 * cannot be provisioned. Never a browser runtime dependency.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { arch, tmpdir } from "node:os";
import { join } from "node:path";

const checksums = {
  arm64: "53b0abacd38ef1b12a66d6c100956691b9cefce018d91f81e73ddf7438b94d77",
  x64: "e5bec3346a873ae91d871550f3e698c1aad962aff462a080e40f25fde17fef6b",
};
const names = {
  arm64: "sops-v3.13.3.linux.arm64",
  x64: "sops-v3.13.3.linux.amd64",
};
const key = arch() === "arm64" ? "arm64" : arch() === "x64" ? "x64" : "";
if (!key) {
  console.error(`incomplete: no pinned sops binary for ${arch()}`);
  process.exit(2);
}
const dir = join(tmpdir(), "opensesame-sops-oracle");
mkdirSync(dir, { recursive: true });
const bin = join(dir, names[key]);
const cached = spawnSync(bin, ["--version"], { encoding: "utf8" });
if (cached.status !== 0) {
  const url = `https://github.com/getsops/sops/releases/download/v3.13.3/${names[key]}`;
  const download = spawnSync("curl", ["-fsSL", "-o", bin, url], {
    stdio: "inherit",
  });
  if (download.status !== 0) {
    console.error("incomplete: could not download pinned sops v3.13.3");
    process.exit(2);
  }
  chmodSync(bin, 0o755);
}
const actual = createHash("sha256").update(readFileSync(bin)).digest("hex");
if (actual !== checksums[key]) {
  console.error("incomplete: sops oracle checksum mismatch");
  process.exit(2);
}
const root = new URL("..", import.meta.url).pathname;
const test = spawnSync(
  "pnpm",
  [
    "--filter",
    "@opensesame/pages",
    "exec",
    "vitest",
    "run",
    "src/lib/sops/engine.conformance.test.ts",
  ],
  { cwd: root, stdio: "inherit", env: { ...process.env, SOPS_BIN: bin } },
);
process.exit(test.status ?? 1);
