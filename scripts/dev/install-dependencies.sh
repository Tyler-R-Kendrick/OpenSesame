#!/usr/bin/env bash
# Install once per manifest/lockfile state; preserve the shared pnpm store.
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
for (const name of [...new Set([...files, "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ".pnpmfile.cjs", ".pnpmfile.mjs"])].sort()) {
  const path = join(root, name);
  hash.update(name).update("\0");
  hash.update(existsSync(path) ? readFileSync(path) : "absent").update("\0");
}
process.stdout.write(hash.digest("hex"));
NODE
)"
marker="node_modules/.cache/opensesame-install.sha256"
installed_lock="node_modules/.pnpm/lock.yaml"
if [[ -f node_modules/.modules.yaml && -f "$marker" ]] \
   && cmp -s pnpm-lock.yaml "$installed_lock" \
   && [[ "$(cat "$marker")" == "$fingerprint" ]]; then
  echo "dependencies: current lockfile already installed"
  exit 0
fi

# Noninteractive pnpm must not cancel a reinstall prompt with a successful exit.
rm -f "$marker"
CI=true pnpm install --frozen-lockfile
# A failed or incomplete installation must never appear current on the next run.
if [[ ! -f node_modules/.modules.yaml ]]; then
  echo "dependencies: installation did not produce pnpm's module manifest" >&2
  exit 1
fi
if ! cmp -s pnpm-lock.yaml "$installed_lock"; then
  echo "dependencies: installed virtual-store lockfile does not match pnpm-lock.yaml" >&2
  exit 1
fi
mkdir -p "$(dirname "$marker")"
printf '%s\n' "$fingerprint" > "$marker"
