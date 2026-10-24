// workflow_dispatch input is data, never shell source or a pnpm selector.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const input = process.env.NPM_PACKAGES ?? "";
if (!input || /[\r\n]/.test(input)) {
  throw new Error("Expected a comma-separated list of workspace package names.");
}
const names = input.split(",").map((name) => name.trim());
if (names.some((name) => !/^@opensesame\/[a-z0-9][a-z0-9._-]*$/.test(name))) {
  throw new Error("Only exact @opensesame workspace package names are allowed.");
}

const packages = new Map();
const root = resolve("packages");
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = join(root, entry.name);
  const manifest = JSON.parse(
    readFileSync(join(directory, "package.json"), "utf8"),
  );
  if (packages.has(manifest.name)) {
    throw new Error("Workspace package names must be unique.");
  }
  packages.set(manifest.name, { directory, private: manifest.private });
}

// Validate the whole request before invoking pnpm, so a bad suffix cannot
// cause a partial release. Resolve directories from manifests, never input.
const selected = [...new Set(names)].map((name) => {
  const pkg = packages.get(name);
  if (!pkg || (pkg.private !== undefined && pkg.private !== false)) {
    throw new Error("Every requested package must exist and be non-private.");
  }
  return pkg.directory;
});
if (!process.env.NODE_AUTH_TOKEN) {
  throw new Error("NPM_TOKEN secret is not configured on this repository.");
}

for (const directory of selected) {
  const result = spawnSync(
    "pnpm",
    ["publish", "--access", "public", "--no-git-checks"],
    { cwd: directory, stdio: "inherit", shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
