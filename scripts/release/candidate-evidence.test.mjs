import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { GitHub } from "./lib/candidate-api.mjs";
import { verifyReceipt } from "./lib/candidate-evidence.mjs";
import { POLICY, hash } from "./lib/candidate-policy.mjs";
import { publicationState } from "./lib/candidate-publication.mjs";

const source = "a".repeat(40);
const control = "b".repeat(40);
const checksum = "1".repeat(64);
const candidate = {
  source_sha: source,
  candidate_id: `${source}-100-1`,
  run_id: "100",
  run_attempt: "1",
  artifact_id: "200",
  artifact_digest: checksum,
  payload_digest: checksum,
};

function evidenceFixture() {
  const ctx = {
    repository: POLICY.repository,
    runId: "300",
    runAttempt: "2",
    token: "test",
    now: Date.parse("2026-10-26T12:00:00Z"),
  };
  const ref = {
    repository: POLICY.repository,
    stage: "dev",
    run_id: "100",
    run_attempt: "1",
    artifact_id: "500",
    artifact_digest: checksum,
  };
  const job = {
    id: 123,
    name: "qualify / Dev gate",
    status: "completed",
    conclusion: "success",
    started_at: "2026-10-26T01:00:00Z",
    completed_at: "2026-10-26T02:00:00Z",
  };
  const run = {
    repository: { full_name: POLICY.repository },
    head_repository: { full_name: POLICY.repository },
    head_branch: "main",
    path: ".github/workflows/dev-nightly.yml",
    event: "schedule",
    run_attempt: 1,
    head_sha: control,
    status: "completed",
    conclusion: "success",
  };
  const receipt = {
    format: "opensesame-qualification",
    schema_version: 1,
    repository: POLICY.repository,
    stage: "dev",
    candidate,
    policy_sha256: checksum,
    completed_at: job.completed_at,
    producer: {
      run_id: "100",
      run_attempt: "1",
      workflow_ref: `${POLICY.repository}/${run.path}@refs/heads/main`,
      workflow_sha: control,
    },
    checks: [
      {
        scope: "Dev gate",
        job_id: "123",
        result: "success",
        completed_at: job.completed_at,
      },
    ],
    prerequisite: null,
  };
  const service = {
    ctx,
    api: { attempt: async () => run, jobs: async () => [job] },
    download: async ({ destination, expectedName }) => {
      assert.equal(expectedName, "qualification-dev-100-1");
      await writeFile(
        join(destination, "receipt.json"),
        JSON.stringify(receipt),
      );
      return {};
    },
    artifactTime: () => {},
    policyHash: async () => checksum,
  };
  return { service, receipt, ref, job, run };
}

test("cross-run receipt requires API success, exact gate job, fresh evidence and matching control revision", async () => {
  const fixture = evidenceFixture();
  const verified = await verifyReceipt(
    fixture.service,
    fixture.ref,
    candidate,
    { stage: "dev", maxAgeHours: 48 },
  );
  assert.equal(verified.candidate.candidate_id, candidate.candidate_id);
  const changes = [
    (data) => {
      data.run.conclusion = "failure";
    },
    (data) => {
      data.job.conclusion = "skipped";
    },
    (data) => {
      data.receipt.checks[0].job_id = "124";
    },
    (data) => {
      data.run.head_sha = source;
    },
    (data) => {
      data.service.ctx.now += 72 * 3600000;
    },
    (data) => {
      data.service.policyHash = async () => "2".repeat(64);
    },
  ];
  for (const change of changes) {
    const data = evidenceFixture();
    change(data);
    await assert.rejects(
      verifyReceipt(data.service, data.ref, candidate, {
        stage: "dev",
        maxAgeHours: 48,
      }),
    );
  }
});

test("a forged stage name cannot exchange one deep suite for another", async () => {
  const data = evidenceFixture();
  await assert.rejects(
    verifyReceipt(
      data.service,
      { ...data.ref, stage: "release-qualified", suite: "security" },
      candidate,
      { stage: "release-qualified", suite: "mutation" },
    ),
    /Unexpected receipt/,
  );
});

test("candidate comparison uses a valid GitHub triple-dot URL rather than rejecting normal ancestry", async () => {
  let requested;
  const api = new GitHub(
    { repository: POLICY.repository, token: "test" },
    async (url) => {
      requested = url;
      return {
        ok: true,
        json: async () => ({ base_commit: { sha: source }, status: "ahead" }),
      };
    },
  );
  assert.equal(await api.ancestor(source, control), true);
  assert.ok(requested.endsWith(`/compare/${source}...${control}`));
});

test("published identical candidate is an explicit no-op while tag collisions and rollback fail", async () => {
  const bytes = Buffer.from('{"candidate":"same"}\n');
  const expected = { ...candidate, payload_digest: hash(bytes) };
  const release = {
    draft: false,
    prerelease: false,
    tag_name: "v1.2.3",
    assets: [{ id: 900, name: "candidate.json" }],
  };
  let tagSha = source;
  let ancestry = true;
  const service = {
    verifyPublished: async (_service, _release, _manifest, actual) => {
      assert.equal(hash(actual), expected.payload_digest);
    },
    api: {
      get: async (path) => {
        if (path.startsWith("/git/ref/"))
          return { object: { type: "commit", sha: tagSha } };
        if (path.startsWith("/releases/assets/")) return bytes;
        if (path.startsWith("/releases/tags/")) return release;
        throw new Error(`Unexpected fixture path ${path}`);
      },
      pages: async () => [release],
      ancestor: async () => ancestry,
    },
  };
  assert.equal(
    (await publicationState(service, expected, { version: "1.2.3" })).promote,
    "false",
  );
  tagSha = control;
  await assert.rejects(
    publicationState(service, expected, { version: "1.2.3" }),
    /Version collision/,
  );
  tagSha = source;
  ancestry = false;
  await assert.rejects(
    publicationState(service, expected, { version: "1.2.3" }),
    /roll back/,
  );
  ancestry = true;
  service.verifyPublished = async () => {
    throw new Error("different candidate bytes");
  };
  await assert.rejects(
    publicationState(service, candidate, { version: "1.2.3" }),
    /different candidate bytes/,
  );
});
