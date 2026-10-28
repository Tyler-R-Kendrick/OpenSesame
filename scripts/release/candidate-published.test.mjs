import assert from "node:assert/strict";
import { basename } from "node:path";
import test from "node:test";
import { inventory } from "./lib/candidate-model.mjs";
import { POLICY, hash } from "./lib/candidate-policy.mjs";
import {
  publishedInventory,
  samePublishedPayload,
} from "./lib/candidate-published.mjs";
import { EVIDENCE_ASSETS, productAssets } from "./stage-release.mjs";

function manifest(run = "100") {
  const source = "a".repeat(40);
  return {
    format: "opensesame-candidate",
    schema_version: 1,
    source_sha: source,
    candidate_id: `${source}-${run}-1`,
    version: "1.2.3",
    producer: {
      run_id: run,
      run_attempt: "1",
      workflow_sha: "b".repeat(40),
      workflow_ref: `${POLICY.repository}/.github/workflows/dev-nightly.yml@refs/heads/main`,
      recipe_path: ".github/workflows/candidate-build.yml",
    },
    source_ci: { run_id: "10", run_attempt: "1" },
    payloads: [...inventory("1.2.3")].map(([path, [role, target]]) => ({
      path,
      role,
      target,
      sha256: hash(path),
      size: Buffer.byteLength(path),
    })),
  };
}

function publicationFixture() {
  const candidate = manifest();
  const bytes = new Map();
  for (const item of candidate.payloads)
    bytes.set(basename(item.path), Buffer.from(item.path));
  bytes.set("candidate.json", Buffer.from(`${JSON.stringify(candidate)}\n`));
  for (const name of EVIDENCE_ASSETS.filter((name) => name !== "SHA256SUMS"))
    bytes.set(name, Buffer.from(name));
  const names = [
    ...productAssets(candidate.version),
    ...EVIDENCE_ASSETS,
  ].sort();
  const sums = names
    .filter((name) => name !== "SHA256SUMS")
    .map((name) => `${hash(bytes.get(name))}  ${name}\n`)
    .join("");
  bytes.set("SHA256SUMS", Buffer.from(sums));
  const assets = names.map((name, index) => ({
    name,
    id: index + 1,
    state: "uploaded",
    size: bytes.get(name).length,
    digest: `sha256:${hash(bytes.get(name))}`,
  }));
  return { candidate, sums, assets };
}

test("expired Actions artifact does not demand a version bump when a new envelope has identical published payloads", () => {
  samePublishedPayload(manifest("100"), manifest("900"));
  const changed = manifest("900");
  changed.payloads[0].sha256 = "f".repeat(64);
  assert.throws(
    () => samePublishedPayload(manifest(), changed),
    /different source or/,
  );
});

test("same version with a different source, role, size or missing target is not an identical publication", () => {
  for (const change of [
    (value) => {
      value.source_sha = "c".repeat(40);
    },
    (value) => {
      value.payloads[0].role = "test-only";
    },
    (value) => {
      value.payloads[0].size++;
    },
    (value) => value.payloads.pop(),
  ]) {
    const selected = manifest("900");
    change(selected);
    assert.throws(() => samePublishedPayload(manifest(), selected));
  }
});

test("no-op requires all product and evidence assets with exact signed checksum coverage", () => {
  const { candidate, sums, assets } = publicationFixture();
  publishedInventory(assets, sums, candidate);
  assert.throws(
    () => publishedInventory(assets.slice(1), sums, candidate),
    /inventory/,
  );
  assert.throws(
    () => publishedInventory([...assets, assets[0]], sums, candidate),
    /inventory/,
  );
  const changed = structuredClone(assets);
  changed[0].digest = `sha256:${"0".repeat(64)}`;
  assert.throws(
    () => publishedInventory(changed, sums, candidate),
    /integrity/,
  );
  assert.throws(
    () =>
      publishedInventory(
        assets,
        sums.split("\n").slice(1).join("\n"),
        candidate,
      ),
    /checksum inventory/,
  );
});

test("asset state, byte size and traversal checksum names cannot masquerade as completed publication", () => {
  const { candidate, sums, assets } = publicationFixture();
  const incomplete = structuredClone(assets);
  incomplete[0].state = "new";
  assert.throws(
    () => publishedInventory(incomplete, sums, candidate),
    /integrity/,
  );
  const wrongSize = structuredClone(assets);
  wrongSize.find((item) => item.name.startsWith("opensesame-kit_")).size++;
  assert.throws(
    () => publishedInventory(wrongSize, sums, candidate),
    /payload/,
  );
  assert.throws(
    () =>
      publishedInventory(
        assets,
        `${sums}${"a".repeat(64)}  ../outside\n`,
        candidate,
      ),
    /malformed/,
  );
});
