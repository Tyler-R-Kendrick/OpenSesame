import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertArtifact } from "./artifact-transfer.mjs";
import {
  previousSelection,
  resumeSelection,
  retainSelection,
  selectWeekly,
  selectionName,
  validateSelection,
} from "./lib/candidate-freeze.mjs";
import { POLICY, hash } from "./lib/candidate-policy.mjs";
import { Candidates } from "./lib/candidate-service.mjs";

const source = "a".repeat(40);
const control = "b".repeat(40);
const policy = "c".repeat(64);
const candidate = {
  source_sha: source,
  candidate_id: `${source}-100-1`,
  run_id: "100",
  run_attempt: "1",
  artifact_id: "200",
  artifact_digest: "d".repeat(64),
  payload_digest: "e".repeat(64),
};
const devReceipt = {
  repository: POLICY.repository,
  stage: "dev",
  run_id: "100",
  run_attempt: "1",
  artifact_id: "201",
  artifact_digest: "f".repeat(64),
};

function recordFor(attempt = "1") {
  return {
    format: "opensesame-weekly-selection",
    schema_version: 1,
    repository: POLICY.repository,
    producer: {
      run_id: "500",
      run_attempt: attempt,
      workflow_sha: control,
      workflow_ref: `${POLICY.repository}/.github/workflows/release-weekly.yml@refs/heads/main`,
    },
    policy_sha256: policy,
    candidate: { ...candidate },
    dev_receipt: { ...devReceipt },
    selection_cutoff: "2026-10-26T08:01:30Z",
    selected_main_sha: control,
  };
}

function fixtureApi(data) {
  return {
    attempt: async (_id, attempt) => ({
      repository: { full_name: POLICY.repository },
      head_repository: { full_name: POLICY.repository },
      head_branch: "main",
      head_sha: control,
      path: ".github/workflows/release-weekly.yml",
      event: "schedule",
      run_attempt: Number(attempt),
      status: "completed",
      conclusion: "failure",
      run_started_at: "2026-10-26T08:00:00Z",
      updated_at: "2026-10-26T08:20:00Z",
    }),
    jobs: async (_id, attempt) => {
      data.queriedAttempts.push(attempt);
      return data.jobs;
    },
    pages: async () => data.artifacts,
    main: async () => control,
    ancestor: async () => true,
  };
}

function fixture() {
  const ctx = {
    repository: POLICY.repository,
    token: "test",
    runId: "500",
    runAttempt: "2",
    workflow: ".github/workflows/release-weekly.yml",
    workflowSha: control,
    workflowRef: `${POLICY.repository}/.github/workflows/release-weekly.yml@refs/heads/main`,
    now: Date.parse("2026-10-26T12:00:00Z"),
  };
  const record = recordFor();
  const artifact = {
    id: 800,
    name: selectionName("500", "1"),
    workflow_run: { id: 500 },
    expired: false,
    digest: `sha256:${hash(JSON.stringify(record))}`,
    created_at: "2026-10-26T08:02:00Z",
    expires_at: "2026-11-30T00:00:00Z",
  };
  const data = {
    record,
    artifact,
    artifacts: [artifact],
    queriedAttempts: [],
    downloads: 0,
    jobs: [
      {
        id: 77,
        name: "Weekly selection",
        status: "completed",
        conclusion: "success",
        started_at: "2026-10-26T08:01:00Z",
        completed_at: "2026-10-26T08:03:00Z",
      },
    ],
  };
  const service = {
    ctx,
    api: fixtureApi(data),
    admission: async () => {},
    policyHash: async () => policy,
    artifactTime: (metadata, run) =>
      Candidates.prototype.artifactTime.call({ ctx }, metadata, run),
    download: async (options) => {
      data.downloads++;
      assertArtifact(artifact, options);
      const bytes = JSON.stringify(data.record);
      assert.equal(
        `sha256:${hash(bytes)}`,
        options.artifactDigest,
        "Downloaded selection digest mismatch",
      );
      await mkdir(options.destination, { recursive: true });
      await writeFile(join(options.destination, "selection.json"), bytes);
      return artifact;
    },
    verify: async (frozen) => {
      assert.deepEqual(frozen, candidate);
      return { manifest: { version: "1.2.3" } };
    },
  };
  return { ...data, service, data };
}

test("retry freezes the earliest successful selection even when newer nightly evidence exists", async () => {
  const { service, data } = fixture();
  service.ctx.runAttempt = "3";
  let newSelections = 0;
  const selected = await selectWeekly(service, 48, {
    choose: async () => {
      newSelections++;
      return { source_sha: "9".repeat(40) };
    },
    resume: async (_service, record) => ({
      ...record.candidate,
      selection_cutoff: record.selection_cutoff,
    }),
  });
  assert.equal(selected.candidate_id, candidate.candidate_id);
  assert.equal(selected.selection_cutoff, "2026-10-26T08:01:30Z");
  assert.equal(newSelections, 0);
  assert.deepEqual(data.queriedAttempts, ["1"]);
});

test("failed or absent original selection jobs cannot authorize frozen evidence", async () => {
  for (const absent of [false, true]) {
    const { service, data } = fixture();
    if (absent) data.jobs = [];
    else data.jobs[0].conclusion = "failure";
    assert.equal(await previousSelection(service), null);
    assert.equal(data.downloads, 0);
  }
});

test("successful selection with missing, expired, tampered or later-job evidence never falls through to latest", async () => {
  const changes = [
    (data) => {
      data.artifacts = [];
    },
    (data) => {
      data.artifact.expired = true;
    },
    (data) => {
      data.artifact.expires_at = "2026-10-26T09:00:00Z";
    },
    (data) => {
      data.record.candidate.source_sha = "9".repeat(40);
    },
    (data) => {
      data.artifact.created_at = "2026-10-26T08:10:00Z";
    },
  ];
  for (const change of changes) {
    const { service, data } = fixture();
    change(data);
    let selectedLatest = false;
    await assert.rejects(
      selectWeekly(service, 48, {
        choose: async () => {
          selectedLatest = true;
        },
      }),
    );
    assert.equal(selectedLatest, false);
  }
});

test("frozen controller, policy and invocation identity must match the same weekly run", async () => {
  const { service } = fixture();
  for (const change of [
    (record) => {
      record.producer.run_id = "501";
    },
    (record) => {
      record.producer.workflow_sha = source;
    },
    (record) => {
      record.policy_sha256 = "0".repeat(64);
    },
    (record) => {
      record.dev_receipt.stage = "prerelease";
    },
  ]) {
    const record = recordFor();
    change(record);
    await assert.rejects(validateSelection(service, record, "1"));
  }
});

test("resumption revalidates original freshness and publication; already-published bytes become an explicit no-op", async () => {
  const { service, record } = fixture();
  let checkedFreshness = false;
  const selected = await resumeSelection(service, record, {
    verifyDev: async (_service, ref, frozen, options) => {
      assert.deepEqual(ref, devReceipt);
      assert.deepEqual(frozen, candidate);
      assert.equal(options.maxAgeHours, 48);
      checkedFreshness = true;
    },
    publication: async () => ({
      version: "1.2.3",
      tag: "v1.2.3",
      promote: "false",
    }),
  });
  assert.equal(selected.promote, "false");
  assert.equal(selected.resumed_from_attempt, "1");
  assert.equal(checkedFreshness, true);
  await assert.rejects(
    resumeSelection(service, record, {
      verifyDev: async () => {
        throw new Error("Qualification evidence expired");
      },
    }),
    /expired/,
  );
});

test("each successful attempt records the same frozen identity without overwriting its selection file", async (t) => {
  const { service } = fixture();
  const directory = await mkdtemp(join(tmpdir(), "candidate-freeze-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "selection.json");
  const selected = {
    ...candidate,
    dev_receipt: JSON.stringify(devReceipt),
    selection_cutoff: "2026-10-26T08:01:30Z",
    selected_main_sha: control,
  };
  await retainSelection(service, selected, file);
  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(stored.candidate, candidate);
  assert.deepEqual(stored.dev_receipt, devReceipt);
  assert.equal(stored.producer.run_attempt, "2");
  await assert.rejects(retainSelection(service, selected, file), /EEXIST/);
});
