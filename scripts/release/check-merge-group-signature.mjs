#!/usr/bin/env node
/**
 * Merge-queue temporary commits are created and signed by GitHub. The PR
 * signature inventory does not apply; verify the merge_group head alone.
 */
import { execFileSync } from "node:child_process";
import { assertMergeGroupSignature } from "../lib/pr-signatures.mjs";

const [repository, head] = process.argv.slice(2);
if (
  process.argv.length !== 4 ||
  !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
  !/^[a-f0-9]{40}$/.test(head ?? "")
) {
  throw new Error(
    "Usage: check-merge-group-signature.mjs OWNER/REPO MERGE_GROUP_HEAD_SHA",
  );
}

function api(path) {
  return JSON.parse(
    execFileSync("gh", ["api", path], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
}

const commit = api(`repos/${repository}/commits/${head}`);
assertMergeGroupSignature(commit, head);
console.log(`Verified merge_group signature at ${head}`);
