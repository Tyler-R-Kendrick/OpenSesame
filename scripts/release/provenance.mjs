#!/usr/bin/env node
// Selected source and controller revision are intentionally separate. Automatic
// provenance's default github.sha is the controller SHA, not necessarily the
// snapshot whose production binaries were compiled. This custom predicate binds
// both, and is signed only by candidate-build.yml after its final inventory.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const BUILD_PREDICATE =
  "https://opensesame.dev/attestations/candidate-build/v1";
export const PROMOTION_PREDICATE =
  "https://opensesame.dev/attestations/release-promotion/v1";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, stable(item)]),
        )
      : value;
export const canonicalJson = (value) => JSON.stringify(stable(value));
const canonical = canonicalJson;

export function buildPredicate(directory) {
  const bytes = readFileSync(join(directory, "candidate.json"));
  const manifest = JSON.parse(bytes);
  return { ...manifest, manifest_sha256: sha256(bytes) };
}

function matchesBuildClaim(claim, manifest, digest) {
  if (claim?.manifest_sha256 !== digest) return false;
  return (
    claim.candidate_id === manifest.candidate_id &&
    claim.source_sha === manifest.source_sha &&
    claim.version === manifest.version &&
    canonical(claim.producer ?? {}) === canonical(manifest.producer) &&
    canonical(claim.source_ci ?? {}) === canonical(manifest.source_ci) &&
    canonical(claim.payloads) === canonical(manifest.payloads)
  );
}

export function assertVerifiedBuild(results, manifest, digest) {
  if (!Array.isArray(results))
    throw new Error("Attestation verification returned no statements");
  const match = results.find((entry) => {
    const statement = entry.verificationResult?.statement;
    return (
      statement?.predicateType === BUILD_PREDICATE &&
      statement.subject?.some((subject) => subject.digest?.sha256 === digest) &&
      matchesBuildClaim(statement.predicate, manifest, digest)
    );
  });
  if (!match)
    throw new Error(
      "Original build attestation does not bind this candidate and producer attempt",
    );
  return match;
}

export async function verifyCandidateProvenance({
  directory,
  repository,
  manifest,
  token,
  execute = execFileSync,
}) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !/^[0-9a-f]{40}$/.test(manifest.producer?.workflow_sha ?? "")
  )
    throw new Error("Invalid provenance identity");
  const file = join(directory, "candidate.json");
  const args = [
    "attestation",
    "verify",
    file,
    "--repo",
    repository,
    "--signer-workflow",
    `${repository}/.github/workflows/candidate-build.yml`,
    "--signer-digest",
    manifest.producer.workflow_sha,
    "--source-ref",
    "refs/heads/main",
    "--source-digest",
    manifest.producer.workflow_sha,
    "--predicate-type",
    BUILD_PREDICATE,
    "--deny-self-hosted-runners",
    "--format",
    "json",
  ];
  const result = execute("gh", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GH_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return assertVerifiedBuild(
    JSON.parse(result),
    manifest,
    sha256(readFileSync(file)),
  );
}

export function verifyPromotionProvenance({
  directory,
  repository,
  workflowSha,
  token,
  execute = execFileSync,
}) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !/^[0-9a-f]{40}$/.test(workflowSha)
  )
    throw new Error("Invalid promotion signer");
  const file = join(directory, "SHA256SUMS");
  const results = JSON.parse(
    execute(
      "gh",
      [
        "attestation",
        "verify",
        file,
        "--repo",
        repository,
        "--signer-workflow",
        `${repository}/.github/workflows/release-publish.yml`,
        "--signer-digest",
        workflowSha,
        "--source-ref",
        "refs/heads/main",
        "--source-digest",
        workflowSha,
        "--predicate-type",
        PROMOTION_PREDICATE,
        "--deny-self-hosted-runners",
        "--format",
        "json",
      ],
      {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GH_TOKEN: token },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  const promotion = JSON.parse(readFileSync(join(directory, "promotion.json")));
  const digest = sha256(readFileSync(file));
  if (
    !results.some(
      (entry) =>
        entry.verificationResult?.statement?.predicateType ===
          PROMOTION_PREDICATE &&
        entry.verificationResult.statement.subject?.some(
          (subject) => subject.digest?.sha256 === digest,
        ) &&
        canonical(entry.verificationResult.statement.predicate) ===
          canonical(promotion),
    )
  )
    throw new Error(
      "Promotion signature does not bind the exact release evidence",
    );
}

function prepare(directory, predicatePath, checksumsPath) {
  const predicate = buildPredicate(directory);
  const files = predicate.payloads.map((payload) => {
    const file = join(directory, payload.path);
    const bytes = readFileSync(file);
    if (sha256(bytes) !== payload.sha256 || bytes.length !== payload.size)
      throw new Error("Payload changed before signing");
    return `${payload.sha256}  ${file}\n`;
  });
  files.push(
    `${predicate.manifest_sha256}  ${join(directory, "candidate.json")}\n`,
  );
  writeFileSync(predicatePath, `${JSON.stringify(predicate)}\n`, {
    flag: "wx",
  });
  writeFileSync(checksumsPath, files.join(""), { flag: "wx" });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [command, directory, predicate, checksums] = process.argv.slice(2);
  if (command !== "prepare" || !checksums)
    throw new Error(
      "usage: provenance.mjs prepare DIRECTORY PREDICATE CHECKSUMS",
    );
  prepare(directory, predicate, checksums);
}
