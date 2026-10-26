#!/usr/bin/env node
// Copy qualified bytes into an explicit release inventory. No builds, stamps,
// version rewriting or archive repacking are permitted during promotion.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, verifyCandidateProvenance } from "./provenance.mjs";

export const EVIDENCE_ASSETS = [
  "dev-receipt.json",
  "prerelease-receipt.json",
  "mutation-receipt.json",
  "security-receipt.json",
  "promotion.json",
  "build-provenance.sigstore.json",
  "SHA256SUMS",
];
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function productAssets(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error("Invalid stable release version");
  const files = [
    `opensesame-pages_v${version}.tar.gz`,
    "opensesame-env-parse.mjs",
    "candidate.json",
  ];
  for (const target of [
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
  ]) {
    files.push(
      `opensesame-kit_v${version}_${target}.tar.gz`,
      `opensesame-surrogate-proxy-TEST-upstream-override_v${version}_${target}.tar.gz`,
    );
  }
  return files.sort();
}

export function releaseInventory(directory, manifest) {
  const expected = [
    ...productAssets(manifest.version),
    ...EVIDENCE_ASSETS,
  ].sort();
  const actual = readdirSync(directory, { withFileTypes: true });
  if (
    actual.some((entry) => !entry.isFile()) ||
    JSON.stringify(actual.map((entry) => entry.name).sort()) !==
      JSON.stringify(expected)
  ) {
    throw new Error(
      "Release asset inventory differs from the explicit allowlist",
    );
  }
  const entries = expected.map((name) => {
    const bytes = readFileSync(join(directory, name));
    return { name, size: bytes.length, sha256: hash(bytes) };
  });
  const sums = entries
    .filter((entry) => entry.name !== "SHA256SUMS")
    .map((entry) => `${entry.sha256}  ${entry.name}\n`)
    .join("");
  if (readFileSync(join(directory, "SHA256SUMS"), "utf8") !== sums)
    throw new Error("Release checksum inventory mismatch");
  return entries;
}

export async function stageRelease({
  directory,
  evidence,
  output,
  repository,
  token,
  execute,
}) {
  const manifest = JSON.parse(readFileSync(join(directory, "candidate.json")));
  const proof = await verifyCandidateProvenance({
    directory,
    repository,
    manifest,
    token,
    execute,
  });
  if (!proof.attestation?.bundle)
    throw new Error("Original signed build bundle is absent");
  mkdirSync(output); // An existing staging tree must never be silently reused.
  const names = manifest.payloads.map((payload) => basename(payload.path));
  if (
    JSON.stringify([...names, "candidate.json"].sort()) !==
    JSON.stringify(productAssets(manifest.version))
  ) {
    throw new Error("Candidate product inventory mismatch");
  }
  for (const payload of manifest.payloads) {
    const bytes = readFileSync(join(directory, payload.path));
    if (hash(bytes) !== payload.sha256 || bytes.length !== payload.size)
      throw new Error("Product changed before staging");
    copyFileSync(
      join(directory, payload.path),
      join(output, basename(payload.path)),
    );
  }
  copyFileSync(
    join(directory, "candidate.json"),
    join(output, "candidate.json"),
  );
  for (const name of EVIDENCE_ASSETS.slice(0, 5))
    copyFileSync(join(evidence, name), join(output, name));
  writeFileSync(
    join(output, "build-provenance.sigstore.json"),
    `${canonicalJson(proof.attestation.bundle)}\n`,
  );
  const namesToHash = [
    ...productAssets(manifest.version),
    ...EVIDENCE_ASSETS.filter((name) => name !== "SHA256SUMS"),
  ].sort();
  writeFileSync(
    join(output, "SHA256SUMS"),
    namesToHash
      .map((name) => `${hash(readFileSync(join(output, name)))}  ${name}\n`)
      .join(""),
  );
  releaseInventory(output, manifest);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [directory, evidence, output] = process.argv.slice(2);
  if (!output)
    throw new Error("usage: stage-release.mjs CANDIDATE EVIDENCE NEW_OUTPUT");
  await stageRelease({
    directory,
    evidence,
    output,
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN,
  });
}
