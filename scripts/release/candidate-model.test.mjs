import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertRun, successfulGate } from "./lib/candidate-api.mjs";
import {
  receiptEnvelope,
  validateNeeds,
  validateReceipt,
} from "./lib/candidate-evidence.mjs";
import {
  envelope,
  inventory,
  validateManifest,
  verifyDirectory,
} from "./lib/candidate-model.mjs";
import { POLICY, context, hash } from "./lib/candidate-policy.mjs";
import { newestByAncestry } from "./lib/candidate-selection.mjs";

const source = "a".repeat(40);
const control = "b".repeat(40);
const checksum = "1".repeat(64);
const identity = {
  source_sha: source,
  candidate_id: `${source}-100-1`,
  run_id: "100",
  run_attempt: "1",
  artifact_id: "200",
  artifact_digest: checksum,
  payload_digest: checksum,
};
const manifest = () => ({
  format: "opensesame-candidate",
  schema_version: 1,
  source_sha: source,
  candidate_id: identity.candidate_id,
  version: "1.2.3",
  producer: {
    run_id: "100",
    run_attempt: "1",
    workflow_ref: `${POLICY.repository}/.github/workflows/dev-nightly.yml@refs/heads/main`,
    workflow_sha: control,
    recipe_path: ".github/workflows/candidate-build.yml",
  },
  source_ci: { run_id: "10", run_attempt: "2" },
  payloads: [...inventory("1.2.3")].map(([path, [role, target]]) => ({
    path,
    role,
    target,
    sha256: hash(path),
    size: Buffer.byteLength(path),
  })),
});

test("candidate identity includes source, producer run and exact attempt", () => {
  assert.deepEqual(envelope(identity), identity);
  for (const replacement of [
    { run_attempt: "2" },
    { source_sha: "b".repeat(40) },
    { artifact_id: "../1" },
    { payload_digest: "not-a-hash" },
    { run_id: "1e3" },
  ]) {
    assert.throws(() => envelope({ ...identity, ...replacement }));
  }
});

test("complete inventory rejects missing targets, duplicate paths, role confusion and prerelease filenames", () => {
  assert.equal(validateManifest(manifest(), identity).payloads.length, 6);
  for (const change of [
    (value) => value.payloads.pop(),
    (value) => {
      value.payloads[1] = value.payloads[0];
    },
    (value) => {
      value.payloads[0].role = "test-only";
    },
    (value) => {
      value.version = "1.2.3-rc.1";
    },
    (value) => {
      value.payloads[0].path = "../outside";
    },
    (value) => {
      value.producer.run_attempt = "2";
    },
    (value) => {
      value.producer.workflow_ref = `${POLICY.repository}/.github/workflows/ci.yml@refs/heads/main`;
    },
  ]) {
    const value = manifest();
    change(value);
    assert.throws(() => validateManifest(value, identity));
  }
});

test("directory verification binds exact manifest bytes and every file; extra files and symlinks fail", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "candidate-model-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = manifest();
  for (const item of value.payloads) {
    await mkdir(dirname(join(directory, item.path)), { recursive: true });
    await writeFile(join(directory, item.path), item.path);
  }
  const bytes = `${JSON.stringify(value)}\n`;
  await writeFile(join(directory, "candidate.json"), bytes);
  const expected = { ...identity, payload_digest: hash(bytes) };
  await verifyDirectory(directory, expected);
  await assert.rejects(
    verifyDirectory(directory, { ...expected, payload_digest: checksum }),
    /manifest digest/,
  );
  await writeFile(join(directory, "unexpected"), "extra");
  await assert.rejects(verifyDirectory(directory, expected), /inventory/);
  await rm(join(directory, "unexpected"));
  const payload = join(directory, value.payloads[0].path);
  await writeFile(payload, "changed");
  await assert.rejects(verifyDirectory(directory, expected), /integrity/);
  await rm(payload);
  await symlink("/etc/passwd", payload);
  await assert.rejects(verifyDirectory(directory, expected), /symlink/);
});

test("controller context rejects non-main, fork, PR and untrusted workflow", () => {
  const valid = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: POLICY.repository,
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_WORKFLOW_REF: `${POLICY.repository}/.github/workflows/dev-nightly.yml@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: control,
    GITHUB_RUN_ID: "100",
    GITHUB_RUN_ATTEMPT: "1",
    GH_TOKEN: "test-token",
  };
  assert.equal(context(valid).runId, "100");
  for (const replacement of [
    { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_REPOSITORY: "other/fork" },
    { GITHUB_EVENT_NAME: "pull_request" },
    {
      GITHUB_WORKFLOW_REF: `${POLICY.repository}/.github/workflows/ci.yml@refs/heads/main`,
    },
  ]) {
    assert.throws(() => context({ ...valid, ...replacement }));
  }
});

test("successful API evidence cannot be substituted with a skipped, duplicate or absent gate", () => {
  const gate = {
    id: 1,
    name: "qualify / Dev gate",
    status: "completed",
    conclusion: "success",
    started_at: "2026-10-26T00:00:00Z",
    completed_at: "2026-10-26T00:01:00Z",
  };
  assert.equal(successfulGate([gate], "Dev gate").id, 1);
  assert.throws(() => successfulGate([], "Dev gate"));
  assert.throws(() => successfulGate([gate, { ...gate, id: 2 }], "Dev gate"));
  for (const conclusion of ["skipped", "failure", "cancelled", null]) {
    assert.throws(() => successfulGate([{ ...gate, conclusion }], "Dev gate"));
  }
  for (const result of ["failure", "cancelled", "skipped", undefined])
    assert.throws(() => validateNeeds({ gate: { result } }));
  assert.throws(() => validateNeeds({}));
  validateNeeds({ gate: { result: "success" } });
});

test("source run validation rejects fork, manual CI, wrong attempt and failed result", () => {
  const run = {
    repository: { full_name: POLICY.repository },
    head_repository: { full_name: POLICY.repository },
    head_branch: "main",
    path: ".github/workflows/ci.yml",
    event: "push",
    head_sha: source,
    run_attempt: 2,
    status: "completed",
    conclusion: "success",
  };
  const options = {
    paths: [run.path],
    events: ["push"],
    sourceSha: source,
    attempt: "2",
  };
  assertRun(run, { repository: POLICY.repository }, options);
  for (const change of [
    { head_repository: { full_name: "other/fork" } },
    { event: "workflow_dispatch" },
    { run_attempt: 3 },
    { status: "in_progress" },
    { conclusion: "failure" },
  ]) {
    assert.throws(() =>
      assertRun(
        { ...run, ...change },
        { repository: POLICY.repository },
        options,
      ),
    );
  }
});

test("ancestry ordering does not confuse a slow older run with a newer source", async () => {
  const older = { source_sha: "old", completed_at: 99 };
  const newer = { source_sha: "new", completed_at: 1 };
  const api = {
    ancestor: async (left, right) => left === "old" && right === "new",
  };
  assert.equal(await newestByAncestry(api, [older, newer]), newer);
  assert.equal(await newestByAncestry(api, [newer, older]), newer);
  await assert.rejects(newestByAncestry(api, []), /No eligible/);
  await assert.rejects(
    newestByAncestry({ ancestor: async () => false }, [older, newer]),
    /divergent/,
  );
});

test("release receipts bind exact suite, current policy, source, attempt and nonvacuous scope", () => {
  const ref = receiptEnvelope({
    repository: POLICY.repository,
    stage: "release-qualified",
    suite: "mutation",
    run_id: "300",
    run_attempt: "2",
    artifact_id: "400",
    artifact_digest: checksum,
  });
  const receipt = {
    format: "opensesame-qualification",
    schema_version: 1,
    repository: POLICY.repository,
    stage: ref.stage,
    suite: ref.suite,
    candidate: identity,
    policy_sha256: checksum,
    producer: {
      run_id: "300",
      run_attempt: "2",
      workflow_sha: control,
      workflow_ref: `${POLICY.repository}/.github/workflows/release-weekly.yml@refs/heads/main`,
    },
    completed_at: "2026-10-26T00:00:00Z",
    checks: [
      {
        scope: "Release mutation gate",
        job_id: "99",
        result: "success",
        completed_at: "2026-10-26T00:00:00Z",
      },
    ],
    prerequisite: { stage: "prerelease" },
  };
  const now = Date.parse("2026-10-26T01:00:00Z");
  validateReceipt(receipt, ref, identity, checksum, now);
  for (const change of [
    (value) => {
      value.suite = "security";
    },
    (value) => {
      value.policy_sha256 = "2".repeat(64);
    },
    (value) => {
      value.producer.run_attempt = "1";
    },
    (value) => {
      value.checks = [];
    },
    (value) => {
      value.checks[0].result = "skipped";
    },
    (value) => {
      value.candidate.artifact_id = "201";
    },
    (value) => {
      value.prerequisite = null;
    },
  ]) {
    const modified = structuredClone(receipt);
    change(modified);
    assert.throws(() =>
      validateReceipt(modified, ref, identity, checksum, now),
    );
  }
});
