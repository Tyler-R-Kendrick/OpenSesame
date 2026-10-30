#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkCodeqlDirectory } from "./check-codeql-sarif.mjs";

// The eight analyses are independent. A missing, duplicate, renamed or
// unexpected artifact must fail the release gate instead of shrinking coverage.
const SARIF_FILES = Object.freeze({
  actions: "actions.sarif",
  "javascript-typescript": "javascript.sarif",
  python: "python.sarif",
  rust: "rust.sarif",
  go: "go.sarif",
  "go-native-wasm": "go.sarif",
  "go-native-host": "go.sarif",
  "java-kotlin": "java.sarif",
});

// Candidate checkout is data only. The checker is always controller-owned.
export function candidateTree(checkout, sourceSha) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha))
    throw new Error("Expected an exact CodeQL source SHA");
  const git = (...args) =>
    execFileSync("git", ["--no-replace-objects", "-C", checkout, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  if (git("rev-parse", "--verify", "HEAD^{commit}") !== sourceSha)
    throw new Error("Candidate checkout does not match the source SHA");
  const tree = git("rev-parse", "--verify", `${sourceSha}^{tree}`);
  if (!/^[a-f0-9]{40}$/.test(tree)) throw new Error("Invalid candidate tree");
  return tree;
}

// The trusted review record is excluded to avoid requiring it to contain its
// own digest. Every other Git entry (including mode, type and object id) is
// bound. The record is controller-owned and included in policy compatibility.
const REVIEW_RECORD = Buffer.from(
  "scripts/release/codeql-reviewed-inputs.json",
);

export function sourceDigestEntries(entries) {
  const hash = createHash("sha256");
  let offset = 0;
  while (offset < entries.length) {
    const end = entries.indexOf(0, offset);
    if (end === -1) throw new Error("Malformed candidate tree entries");
    const tab = entries.indexOf(9, offset);
    if (tab === -1 || tab > end)
      throw new Error("Malformed candidate tree entry");
    if (!entries.subarray(tab + 1, end).equals(REVIEW_RECORD)) {
      hash.update(entries.subarray(offset, end + 1));
    }
    offset = end + 1;
  }
  return hash.digest("hex");
}

export function candidateSourceDigest(checkout, tree) {
  if (!/^[a-f0-9]{40}$/.test(tree)) throw new Error("Invalid candidate tree");
  const entries = execFileSync(
    "git",
    [
      "--no-replace-objects",
      "-C",
      checkout,
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      tree,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return sourceDigestEntries(entries);
}

export function checkCodeqlArtifacts(directory, sourceSha, sourceDigest) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha))
    throw new Error("Expected an exact CodeQL source SHA");
  if (!/^[a-f0-9]{64}$/.test(sourceDigest))
    throw new Error("Expected a candidate source digest");
  const expected = new Map(
    Object.entries(SARIF_FILES).map(([language, file]) => [
      `codeql-sarif-${language}-${sourceSha}`,
      { file, category: `/language:${language}/` },
    ]),
  );
  const artifacts = readdirSync(directory, { withFileTypes: true });
  if (
    artifacts.length !== expected.size ||
    artifacts.some(
      (artifact) => !artifact.isDirectory() || !expected.has(artifact.name),
    )
  )
    throw new Error("CodeQL artifact set is incomplete or unexpected");
  for (const artifact of artifacts) {
    const folder = join(directory, artifact.name);
    const entries = readdirSync(folder, { withFileTypes: true });
    if (
      entries.length !== 1 ||
      !entries[0].isFile() ||
      entries[0].name !== expected.get(artifact.name).file
    )
      throw new Error(`Unexpected SARIF files in ${artifact.name}`);
    checkCodeqlDirectory(folder, sourceDigest);
    const report = JSON.parse(
      readFileSync(join(folder, entries[0].name), "utf8"),
    );
    const category = expected.get(artifact.name).category;
    if (report.runs.some((run) => run.automationDetails?.id !== category))
      throw new Error(
        `Unexpected CodeQL language category in ${artifact.name}`,
      );
  }
  return artifacts.length;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 5)
    throw new Error(
      "Usage: check-codeql-artifacts.mjs DIRECTORY SOURCE_SHA CANDIDATE_CHECKOUT",
    );
  const tree = candidateTree(process.argv[4], process.argv[3]);
  const digest = candidateSourceDigest(process.argv[4], tree);
  console.log(
    `CodeQL evidence: ${checkCodeqlArtifacts(process.argv[2], process.argv[3], digest)} complete language artifacts`,
  );
}
