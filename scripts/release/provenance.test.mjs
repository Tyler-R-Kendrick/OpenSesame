import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BUILD_PREDICATE,
  assertVerifiedBuild,
  canonicalJson,
  verifyCandidateProvenance,
} from "./provenance.mjs";

const manifest = {
  candidate_id: `${"a".repeat(40)}-101-2`,
  source_sha: "a".repeat(40),
  version: "0.2.0",
  producer: {
    run_id: "101",
    run_attempt: "2",
    workflow_sha: "b".repeat(40),
    workflow_ref:
      "owner/repo/.github/workflows/dev-nightly.yml@refs/heads/main",
    recipe_path: ".github/workflows/candidate-build.yml",
  },
  source_ci: { run_id: "100", run_attempt: "1" },
  payloads: [
    {
      path: "production/file",
      sha256: "c".repeat(64),
      size: 1,
      role: "production",
      target: "pages",
    },
  ],
};
const bytes = Buffer.from(JSON.stringify(manifest));
const digest = createHash("sha256").update(bytes).digest("hex");
const verified = () => [
  {
    attestation: { bundle: { original: true } },
    verificationResult: {
      statement: {
        predicateType: BUILD_PREDICATE,
        subject: [{ name: "candidate.json", digest: { sha256: digest } }],
        predicate: { ...structuredClone(manifest), manifest_sha256: digest },
      },
    },
  },
];

test("persisted build bundles are independent of JSON property order and preserve array order", () => {
  assert.equal(
    canonicalJson({ z: [{ b: 2, a: 1 }, 3], a: { z: 2, b: 1 } }),
    canonicalJson({ a: { b: 1, z: 2 }, z: [{ a: 1, b: 2 }, 3] }),
  );
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test("verified original build binds source, producer attempt, source CI and payloads", () => {
  assert.doesNotThrow(() => assertVerifiedBuild(verified(), manifest, digest));
  for (const mutate of [
    (claim) => {
      claim.source_sha = "f".repeat(40);
    },
    (claim) => {
      claim.producer.run_attempt = "3";
    },
    (claim) => {
      claim.source_ci.run_id = "999";
    },
    (claim) => {
      claim.payloads[0].sha256 = "e".repeat(64);
    },
    (claim) => {
      claim.manifest_sha256 = "0".repeat(64);
    },
  ]) {
    const bad = verified();
    mutate(bad[0].verificationResult.statement.predicate);
    assert.throws(() => assertVerifiedBuild(bad, manifest, digest));
  }
});

test("verifier pins reusable signer and controller digest, distinct from selected application SHA", async () => {
  const directory = mkdtempSync(join(tmpdir(), "provenance-test-"));
  try {
    writeFileSync(join(directory, "candidate.json"), bytes);
    await verifyCandidateProvenance({
      directory,
      repository: "owner/repo",
      manifest,
      token: "test",
      execute(command, args) {
        assert.equal(command, "gh");
        const value = (flag) => args[args.indexOf(flag) + 1];
        assert.equal(
          value("--signer-workflow"),
          "owner/repo/.github/workflows/candidate-build.yml",
        );
        assert.equal(value("--source-ref"), "refs/heads/main");
        assert.equal(value("--signer-digest"), manifest.producer.workflow_sha);
        assert.equal(value("--source-digest"), manifest.producer.workflow_sha);
        assert.notEqual(value("--source-digest"), manifest.source_sha);
        assert.equal(value("--predicate-type"), BUILD_PREDICATE);
        assert.ok(args.includes("--deny-self-hosted-runners"));
        return JSON.stringify(verified());
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
