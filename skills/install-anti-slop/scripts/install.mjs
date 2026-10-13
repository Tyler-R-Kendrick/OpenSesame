#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isTestOnly, listFiles } from "../assets/anti-slop/verify.mjs";

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(skillRoot, "assets/anti-slop");
const arguments_ = process.argv.slice(2);
const OPTIONS = ["--force", "--no-tests"];

// Anything that is not an accepted option or the one destination is refused
// before a file is written: a typo such as `--no-test` must never install the tests.
function parseArguments(argumentsList) {
  let destination;
  for (const argument of argumentsList) {
    if (argument.startsWith("-") && !OPTIONS.includes(argument)) {
      return { refusal: `Unknown option "${argument}"; the accepted options are --force and --no-tests.` };
    }
    if (argument.startsWith("-")) continue;
    if (argument === "") return { refusal: "The destination is an empty string; pass a path or leave it out." };
    if (destination !== undefined) {
      return { refusal: `Unexpected extra argument "${argument}"; install.mjs takes at most one destination.` };
    }
    destination = argument;
  }
  return { destination };
}

const { destination: targetArgument, refusal } = parseArguments(arguments_);
if (refusal !== undefined) {
  console.error(refusal);
  process.exit(2);
}
const target = resolve(process.cwd(), targetArgument ?? "tools/oxlint/anti-slop");
const force = arguments_.includes("--force");
const noTests = arguments_.includes("--no-tests");

if (existsSync(target) && !force) {
  console.error(`Refusing to overwrite ${target}. Re-run with --force only after reviewing the existing files.`);
  process.exit(1);
}

// `isTestOnly` is verify.mjs's own predicate, so what is left out here is what
// `verify.mjs --no-tests` does not expect.
const keep = (path) => !noTests || !isTestOnly(relative(source, path).split(sep).join("/"));

mkdirSync(dirname(target), { recursive: true });
cpSync(source, target, { recursive: true, force, filter: keep });
console.log(`Copied the anti-slop plugin to ${target}`);
console.log(`Configure Oxlint with: ${target}/index.ts`);
if (noTests) {
  const left = listFiles(source).filter(isTestOnly).length;
  console.log(`Left out ${left} test files (--no-tests). Verify the copy with: node ${target}/verify.mjs --no-tests`);
}
