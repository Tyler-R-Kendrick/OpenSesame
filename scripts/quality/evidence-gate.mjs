#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  EVIDENCE_ROOT,
  assertNoSymlinkParents,
  readTree,
  validateEvidence,
} from "../lib/evidence-policy.mjs";

let repositoryRoot;
function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

try {
  const root = git(["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  repositoryRoot = root;
  const files = new Map();
  if (process.argv.includes("--staged")) {
    // Validate index blobs, including file modes, rather than unstaged worktree content.
    const entries = git(["ls-files", "--stage", "-z", "--", "docs"], {
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean);
    for (const entry of entries) {
      const separator = entry.indexOf("\t");
      const metadata = entry.slice(0, separator);
      const name = entry.slice(separator + 1);
      if (
        name !== "docs" &&
        name !== EVIDENCE_ROOT &&
        !name.startsWith(`${EVIDENCE_ROOT}/`)
      )
        continue;
      const [mode, object, stage] = metadata.split(" ");
      if (!/^100(?:644|755)$/u.test(mode) || stage !== "0")
        throw new Error(`unsafe or unresolved staged evidence: ${name}`);
      files.set(
        name.slice(EVIDENCE_ROOT.length + 1),
        git(["cat-file", "blob", object]),
      );
    }
  } else {
    assertNoSymlinkParents(join(root, EVIDENCE_ROOT));
    if (existsSync(join(root, EVIDENCE_ROOT))) {
      for (const entry of readTree(join(root, EVIDENCE_ROOT)))
        files.set(...entry);
    }
  }
  const slots = validateEvidence(files);
  // sourceCommit is immutable review provenance. A squash merge intentionally
  // removes branch ancestry; only promotion checks ancestry before persisting.
  console.log(
    `evidence: ${slots.length} approved current-state slots validated${process.argv.includes("--staged") ? " in index" : ""}`,
  );
} catch (error) {
  console.error(`evidence: ${error.message}`);
  process.exitCode = 1;
}
