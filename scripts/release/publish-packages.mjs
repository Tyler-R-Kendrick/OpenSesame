import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isString } from "../lib/json-boundary.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Resolve exact names to package directories. Never pass a caller-controlled
// pnpm filter, option, or shell program to publication credentials.
export function selectedPackages(input, repository = root) {
  if (!isString(input) || /[\r\n]/.test(input)) {
    throw new Error("Expected a comma-separated package list");
  }
  const known = new Map();
  for (const entry of readdirSync(join(repository, "packages"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const directory = join(repository, "packages", entry.name);
    const manifest = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    );
    known.set(manifest.name, directory);
  }
  const names = input.split(",").map((value) => value.trim());
  if (
    !names.length ||
    names.some(
      (value) =>
        !/^@opensesame\/[a-z0-9][a-z0-9-]*$/.test(value) || !known.has(value),
    )
  ) {
    throw new Error("Only exact workspace package names are accepted");
  }
  return [...new Set(names)].map((value) => known.get(value));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const directories = selectedPackages(process.env.NPM_PACKAGES);
  for (const cwd of directories) {
    const result = spawnSync(
      "pnpm",
      ["publish", "--access", "public", "--no-git-checks"],
      {
        cwd,
        stdio: "inherit",
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
