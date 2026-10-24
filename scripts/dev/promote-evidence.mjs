#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  EVIDENCE_ROOT,
  assertNoSymlinkParents,
  assertPayloadPath,
  assertSlot,
  readTree,
  sha256,
  validateSlot,
} from "../lib/evidence-policy.mjs";

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function contained(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

try {
  const [slot, input, ...options] = process.argv.slice(2);
  if (!slot || !input || options.length !== 6)
    throw new Error(
      "usage: promote-evidence.mjs feature/project/platform candidate-dir --source <sha> --approved-by <reviewer> --approval-ref <review-reference>",
    );
  assertSlot(slot);
  const flags = {};
  for (let i = 0; i < options.length; i += 2) {
    const key = options[i];
    if (
      !["--source", "--approved-by", "--approval-ref"].includes(key) ||
      key in flags
    )
      throw new Error(`invalid option ${key}`);
    flags[key] = options[i + 1];
  }
  const root = git(["rev-parse", "--show-toplevel"]);
  const destination = join(root, EVIDENCE_ROOT, slot);
  const candidate = resolve(input);
  if (
    contained(candidate, destination) ||
    contained(destination, candidate) ||
    contained(join(root, EVIDENCE_ROOT), candidate)
  )
    throw new Error(
      "candidate must be outside persisted evidence and must not contain its destination",
    );
  assertNoSymlinkParents(candidate);
  assertNoSymlinkParents(destination);
  const files = readTree(candidate);
  if (files.has("manifest.json"))
    throw new Error(
      "candidate must not contain a prior manifest; supply reviewed current files only",
    );
  for (const name of files.keys()) assertPayloadPath(name);
  const manifest = {
    version: 1,
    status: "approved",
    sourceCommit: flags["--source"],
    approval: {
      by: flags["--approved-by"],
      reference: flags["--approval-ref"],
    },
    files: [...files].map(([path, bytes]) => ({ path, sha256: sha256(bytes) })),
  };
  files.set(
    "manifest.json",
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
  );
  validateSlot(slot, files);
  git(["merge-base", "--is-ancestor", manifest.sourceCommit, "HEAD"]);
  // Complete validation before touching an existing slot. Rename within one filesystem.
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  const transaction = mkdtempSync(join(parent, ".evidence-promotion-"));
  const next = join(transaction, "next");
  const previous = join(transaction, "previous");
  let replaced = false;
  let installed = false;
  try {
    mkdirSync(next);
    for (const [name, bytes] of files) {
      mkdirSync(dirname(join(next, name)), { recursive: true });
      writeFileSync(join(next, name), bytes);
    }
    if (existsSync(destination)) {
      renameSync(destination, previous);
      replaced = true;
    }
    try {
      renameSync(next, destination);
      installed = true;
    } catch (error) {
      if (replaced) {
        renameSync(previous, destination);
        replaced = false;
      }
      throw error;
    }
  } finally {
    // If rollback itself fails, retain the previous slot for recovery.
    if (installed || !replaced)
      rmSync(transaction, { recursive: true, force: true });
  }
  console.log(
    `evidence: replaced ${EVIDENCE_ROOT}/${slot} with the reviewed current files`,
  );
} catch (error) {
  console.error(`evidence promotion: ${error.message}`);
  process.exitCode = 1;
}
