#!/usr/bin/env node
/** Bound checked-out source size; private scratch and historical runs stay out of Git. */
import { execFileSync } from "node:child_process";
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decodeJsonText } from "../lib/json-text.mjs";

const POLICY = "tools/quality/repository-size-policy.json";
let root;
function git(args, stdin = "ignore") {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: [stdin, "pipe", "pipe"],
  });
}
function stat(path) {
  try {
    return lstatSync(join(root, path));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}
/** A replaced directory's old indexed descendants are deleted, not extra link copies. */
function workingSize(path) {
  let parent = dirname(path);
  while (parent !== ".") {
    if (stat(parent)?.isSymbolicLink()) return null;
    parent = dirname(parent);
  }
  const info = stat(path);
  if (!info) return null;
  if (info.isSymbolicLink())
    return Buffer.byteLength(readlinkSync(join(root, path)));
  if (!info.isFile()) throw new Error(`not a source file: ${path}`);
  return info.size;
}
function validatePolicy(policy) {
  if (policy.version !== 1) throw new Error("unsupported size policy version");
  for (const key of ["maxTrackedBytes", "maxFileBytes", "maxFiles"]) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0)
      throw new Error(`invalid size policy: ${key}`);
  }
  for (const key of ["forbiddenDirectoryNames", "forbiddenPathPatterns"]) {
    if (!Array.isArray(policy[key]))
      throw new Error(`invalid size policy: ${key}`);
    for (const value of policy[key]) {
      if (!decodeJsonText(value, `invalid size policy: ${key}`))
        throw new Error(`invalid size policy: ${key}`);
    }
  }
}
function stagedFiles() {
  const entries = git(["ls-files", "--stage", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("\t");
      const [mode, object, stage] = line.slice(0, separator).split(" ");
      const path = line.slice(separator + 1);
      if (!["100644", "100755", "120000"].includes(mode) || stage !== "0")
        throw new Error(`unsafe or unresolved staged source: ${path}`);
      return { path, object };
    });
  const objects = [...new Set(entries.map((entry) => entry.object))];
  if (!objects.length) return [];
  const sizes = new Map();
  // Inspect only the unique index blobs, never the entire retained object history.
  // A private file descriptor works in harnesses that cannot forward pipe input.
  const temporary = mkdtempSync(join(tmpdir(), "repository-size-index-"));
  let descriptor;
  let result;
  try {
    const input = join(temporary, "objects");
    writeFileSync(input, `${objects.join("\n")}\n`, { mode: 0o600 });
    descriptor = openSync(input, "r");
    result = git(
      ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      descriptor,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { recursive: true, force: true });
  }
  for (const line of result.trim().split("\n")) {
    const [object, type, bytes] = line.split(" ");
    if (type === "blob" && Number.isSafeInteger(Number(bytes)))
      sizes.set(object, Number(bytes));
  }
  return entries.map(({ path, object }) => {
    if (!sizes.has(object)) throw new Error(`missing staged blob: ${path}`);
    return [path, sizes.get(object)];
  });
}

try {
  if (process.argv.slice(2).some((arg) => arg !== "--staged"))
    throw new Error("usage: repository-size-gate.mjs [--staged]");
  root = git(["rev-parse", "--show-toplevel"]).trim();
  const staged = process.argv.includes("--staged");
  if (!staged && !stat(POLICY)?.isFile())
    throw new Error("size policy must be a regular file");
  const policy = JSON.parse(
    staged
      ? git(["show", `:${POLICY}`])
      : readFileSync(join(root, POLICY), "utf8"),
  );
  validatePolicy(policy);
  const patterns = policy.forbiddenPathPatterns.map(
    (pattern) => new RegExp(pattern, "u"),
  );
  const files = staged
    ? stagedFiles()
    : [
        ...new Set(
          git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
            .split("\0")
            .filter(Boolean),
        ),
      ].flatMap((path) => {
        const bytes = workingSize(path);
        return bytes === null ? [] : [[path, bytes]];
      });
  const errors = [];
  let total = 0;
  for (const [path, bytes] of files) {
    total += bytes;
    const directories = path.split("/");
    if (
      directories.some((part) =>
        policy.forbiddenDirectoryNames.includes(part),
      ) ||
      patterns.some((pattern) => pattern.test(path))
    )
      errors.push(`generated output/history must stay untracked: ${path}`);
    if (bytes > policy.maxFileBytes)
      errors.push(
        `${path}: ${bytes} bytes exceeds single-file limit ${policy.maxFileBytes}`,
      );
  }
  if (total > policy.maxTrackedBytes)
    errors.push(
      `${total} bytes exceeds repository limit ${policy.maxTrackedBytes}`,
    );
  if (files.length > policy.maxFiles)
    errors.push(
      `${files.length} files exceeds repository limit ${policy.maxFiles}`,
    );
  console.log(
    `repository size: ${total} bytes, ${files.length} files${staged ? " in index" : " in working tree"} (limits ${policy.maxTrackedBytes} bytes / ${policy.maxFiles} files)`,
  );
  if (errors.length) throw new Error(errors.join("\n"));
} catch (error) {
  console.error(`repository size: ${error.message}`);
  process.exitCode = 1;
}
