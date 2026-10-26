import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  POLICY,
  demand,
  digest,
  hash,
  identifier,
  sha,
} from "./candidate-policy.mjs";

export const ENVELOPE_KEYS = [
  "source_sha",
  "candidate_id",
  "run_id",
  "run_attempt",
  "artifact_id",
  "artifact_digest",
  "payload_digest",
];

export function envelope(input) {
  demand(
    input && typeof input === "object" && !Array.isArray(input),
    "Candidate envelope is missing",
  );
  const result = {
    source_sha: sha(input.source_sha),
    run_id: identifier(input.run_id),
    run_attempt: identifier(input.run_attempt),
    artifact_id: identifier(input.artifact_id),
    artifact_digest: digest(input.artifact_digest),
    payload_digest: digest(input.payload_digest),
    candidate_id: String(input.candidate_id),
  };
  demand(
    result.candidate_id ===
      `${result.source_sha}-${result.run_id}-${result.run_attempt}`,
    "Candidate identity mismatch",
  );
  return result;
}

export function envelopeFromEnv(env = process.env) {
  return envelope({
    source_sha: env.SOURCE_SHA,
    candidate_id: env.CANDIDATE_ID,
    run_id: env.CANDIDATE_RUN_ID,
    run_attempt: env.CANDIDATE_RUN_ATTEMPT,
    artifact_id: env.ARTIFACT_ID,
    artifact_digest: env.ARTIFACT_DIGEST,
    payload_digest: env.PAYLOAD_DIGEST,
  });
}

export function sameCandidate(left, right) {
  const a = envelope(left);
  const b = envelope(right);
  return ENVELOPE_KEYS.every((key) => a[key] === b[key]);
}

export function inventory(version) {
  demand(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version),
    "Candidate version must be stable semver",
  );
  const tag = `v${version}`;
  const expected = new Map([
    [`production/opensesame-pages_${tag}.tar.gz`, ["production", "pages"]],
    ["production/opensesame-env-parse.mjs", ["production", "node22"]],
  ]);
  for (const target of [
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
  ]) {
    expected.set(`production/opensesame-kit_${tag}_${target}.tar.gz`, [
      "production",
      target,
    ]);
    expected.set(
      `test-only/opensesame-surrogate-proxy-TEST-upstream-override_${tag}_${target}.tar.gz`,
      ["test-only", target],
    );
  }
  return expected;
}

export function validateManifest(manifest, expected) {
  demand(
    manifest?.format === "opensesame-candidate" &&
      manifest.schema_version === 1,
    "Unknown candidate schema",
  );
  demand(
    manifest.source_sha === expected.source_sha &&
      manifest.candidate_id === expected.candidate_id,
    "Manifest source mismatch",
  );
  validateProducer(manifest, expected);
  validatePayloads(manifest);
  return manifest;
}

function validateProducer(manifest, expected) {
  demand(
    String(manifest.producer?.run_id) === expected.run_id &&
      String(manifest.producer?.run_attempt) === expected.run_attempt,
    "Manifest producer invocation mismatch",
  );
  const trusted = POLICY.producers.map(
    (path) => `${POLICY.repository}/${path}@refs/heads/main`,
  );
  demand(
    trusted.includes(manifest.producer.workflow_ref),
    "Manifest controller is not trusted",
  );
  sha(manifest.producer.workflow_sha, "producer workflow SHA");
  demand(
    manifest.producer.recipe_path === ".github/workflows/candidate-build.yml",
    "Untrusted build recipe",
  );
  identifier(manifest.source_ci?.run_id, "source CI run");
  identifier(manifest.source_ci?.run_attempt, "source CI attempt");
}

function validatePayloads(manifest) {
  const required = inventory(manifest.version);
  demand(
    Array.isArray(manifest.payloads) &&
      manifest.payloads.length === required.size,
    "Incomplete candidate payload set",
  );
  const seen = new Set();
  for (const item of manifest.payloads) {
    demand(
      item &&
        typeof item.path === "string" &&
        required.has(item.path) &&
        !seen.has(item.path),
      "Unexpected or duplicate payload",
    );
    seen.add(item.path);
    const [role, target] = required.get(item.path);
    demand(
      item.role === role && item.target === target,
      "Payload role or target mismatch",
    );
    digest(item.sha256, "payload hash");
    demand(
      Number.isSafeInteger(item.size) && item.size > 0,
      "Invalid payload size",
    );
  }
}

async function listFiles(root, relative = "") {
  const result = [];
  for (const name of await readdir(resolve(root, relative))) {
    const path = relative ? `${relative}/${name}` : name;
    const stat = await lstat(resolve(root, path));
    demand(!stat.isSymbolicLink(), "Candidate contains a symlink");
    if (stat.isDirectory()) result.push(...(await listFiles(root, path)));
    else {
      demand(stat.isFile(), "Candidate contains a non-regular file");
      result.push(path);
    }
  }
  return result.sort();
}

export async function verifyDirectory(directory, expected) {
  const bytes = await readFile(resolve(directory, "candidate.json"));
  demand(
    bytes.length < 1024 * 1024 && hash(bytes) === expected.payload_digest,
    "Candidate manifest digest mismatch",
  );
  const manifest = validateManifest(JSON.parse(bytes), expected);
  const actual = await listFiles(directory);
  const wanted = [
    "candidate.json",
    ...manifest.payloads.map((item) => item.path),
  ].sort();
  demand(
    JSON.stringify(actual) === JSON.stringify(wanted),
    "Candidate file inventory mismatch",
  );
  for (const item of manifest.payloads) {
    const file = resolve(directory, item.path);
    const stat = await lstat(file);
    const checksum = createHash("sha256");
    for await (const chunk of createReadStream(file)) checksum.update(chunk);
    demand(
      stat.size === item.size && checksum.digest("hex") === item.sha256,
      `Payload integrity failure: ${item.path}`,
    );
  }
  return manifest;
}

export function candidateOutputs(directory, manifest) {
  const result = {
    source_sha: manifest.source_sha,
    version: manifest.version,
    candidate_directory: resolve(directory),
  };
  for (const item of manifest.payloads.filter(
    (item) => item.role === "production",
  )) {
    if (item.target === "pages")
      result.pages_archive = resolve(directory, item.path);
    if (item.target === "x86_64-unknown-linux-gnu")
      result.native_x86_archive = resolve(directory, item.path);
    if (item.target === "aarch64-unknown-linux-gnu")
      result.native_arm_archive = resolve(directory, item.path);
  }
  return result;
}
