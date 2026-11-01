#!/usr/bin/env bash
# Install once per manifest/lockfile state.
set -euo pipefail
unset NODE_OPTIONS
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

fingerprint="$(node --input-type=module - "$ROOT" <<'NODE'
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const root = process.argv[2];
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "package.json", "**/package.json", "patches/*"], {
  cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).split("\0").filter(Boolean);
const hash = createHash("sha256");
hash.update(`${process.version}:${process.platform}:${process.arch}\0`);
for (const name of [...new Set([...files, "package-lock.json", "pnpm-workspace.yaml", ".npmrc"])].sort()) {
  const path = join(root, name);
  hash.update(name).update("\0");
  hash.update(existsSync(path) ? readFileSync(path) : "absent").update("\0");
}
process.stdout.write(hash.digest("hex"));
NODE
)"
marker="node_modules/.cache/opensesame-install.sha256"
installed_lock="node_modules/.package-lock.json"
lock_matches() {
  [[ -f package-lock.json && -f "$installed_lock" ]] || return 1
  node --input-type=module - "$ROOT" <<'NODE'
import { readFileSync } from "node:fs";
import { join } from "node:path";
const root = process.argv[2];
const source = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const installed = JSON.parse(readFileSync(join(root, "node_modules/.package-lock.json"), "utf8"));
if (installed.lockfileVersion !== source.lockfileVersion) process.exit(1);
if (installed.name !== source.name) process.exit(1);
const src = source.packages ?? {};
const got = installed.packages ?? {};
for (const [key, value] of Object.entries(src)) {
  if (key === "") continue;
  if (value && value.optional === true && !Object.hasOwn(got, key)) continue;
  if (!Object.hasOwn(got, key)) process.exit(1);
  if (JSON.stringify(got[key]) !== JSON.stringify(value)) process.exit(1);
}
for (const key of Object.keys(got)) {
  if (key === "") continue;
  if (!Object.hasOwn(src, key)) process.exit(1);
}
NODE
}

if [[ -f "$installed_lock" && -f "$marker" ]] \
   && lock_matches \
   && [[ "$(cat "$marker")" == "$fingerprint" ]]; then
  echo "dependencies: current lockfile already installed"
  exit 0
fi

# A cancelled or partial npm ci must not be recorded as a current install.
rm -f "$marker"
CI=true npm ci
if [[ ! -f "$installed_lock" ]]; then
  echo "dependencies: installation did not produce npm's module lock" >&2
  exit 1
fi
if ! lock_matches; then
  echo "dependencies: installed module lockfile does not match package-lock.json" >&2
  exit 1
fi
mkdir -p "$(dirname "$marker")"
printf '%s\n' "$fingerprint" > "$marker"
