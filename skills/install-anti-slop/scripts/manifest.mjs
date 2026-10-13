#!/usr/bin/env node
// Writes, or with --check verifies, assets/anti-slop/MANIFEST.sha256: one
// `<sha256>  <path>` line per file the installer ships. Run it (as
// `pnpm anti-slop:manifest`) after any change to the asset, in the same commit.
//
//   node manifest.mjs                  rewrite the manifest
//   node manifest.mjs --check          exit 1 when the committed manifest is stale
//   node manifest.mjs --dir <path>     work on another copy of the asset
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANIFEST_NAME,
  renderManifest,
  verifyTree,
} from "../assets/anti-slop/verify.mjs";

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const check = args.includes("--check");
const dirIndex = args.indexOf("--dir");
const dirValue = dirIndex === -1 ? undefined : args[dirIndex + 1];
const known = new Set(["--check", "--dir", dirValue]);

if (args.some((argument) => !known.has(argument)) || (dirIndex !== -1 && dirValue === undefined)) {
  console.error("Usage: node manifest.mjs [--check] [--dir <path>]");
  process.exit(2);
}

const dir =
  dirValue === undefined
    ? join(skillRoot, "assets/anti-slop")
    : resolve(process.cwd(), dirValue);
const manifest = join(dir, MANIFEST_NAME);

let rendered;
try {
  rendered = renderManifest(dir);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const lines = rendered.split("\n").length - 1;

if (!check) {
  writeFileSync(manifest, rendered);
  console.log(`Wrote ${manifest} (${lines} files).`);
} else if (existsSync(manifest) && readFileSync(manifest, "utf8") === rendered) {
  console.log(`${MANIFEST_NAME} is current (${lines} files).`);
} else {
  console.error(
    `${manifest} is stale: it differs from the files beside it. Run "pnpm anti-slop:manifest" and commit the result.`,
  );
  for (const problem of verifyTree(dir).problems.slice(0, 10))
    console.error(problem);
  process.exit(1);
}
