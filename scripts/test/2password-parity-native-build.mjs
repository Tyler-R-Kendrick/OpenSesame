#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const directory = path.join(root, "work/2password-native-artifacts");
const manifestPath = `${directory}.json`;
await rm(manifestPath, { force: true });
await rm(directory, { force: true, recursive: true });
await mkdir(directory, { recursive: true, mode: 0o700 });
const artifacts = {};
async function prepare(key, args, target, test) {
  const result = spawnSync(
    "cargo",
    ["+1.88.0", ...args, "--message-format=json"],
    {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"],
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(`Native preparation failed: ${key}`);
  const matches = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter(
      (entry) =>
        entry.reason === "compiler-artifact" &&
        entry.target.name === target &&
        entry.profile.test === test &&
        entry.executable,
    );
  if (matches.length !== 1)
    throw new Error(`Native preparation requires one exact executable: ${key}`);
  const destination = path.join(
    directory,
    key === "production" ? "opensesame" : key,
  );
  await copyFile(matches[0].executable, destination);
  await chmod(destination, 0o700);
  artifacts[key] = {
    path: destination,
    sha256: createHash("sha256")
      .update(await readFile(destination))
      .digest("hex"),
  };
}
await prepare(
  "production",
  ["build", "-p", "opensesame-cli"],
  "opensesame",
  false,
);
await prepare(
  "cli",
  ["test", "-p", "opensesame-cli", "--bin", "opensesame", "--no-run"],
  "opensesame",
  true,
);
await prepare(
  "connector",
  ["test", "-p", "opensesame-connector-host", "--lib", "--no-run"],
  "opensesame_connector_host",
  true,
);
await writeFile(manifestPath, `${JSON.stringify(artifacts, null, 2)}\n`, {
  mode: 0o600,
});
console.log(
  "Native preparation captured fresh production and exact test executables.",
);
