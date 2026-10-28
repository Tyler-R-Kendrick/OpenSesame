import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { GitHub, policyEntriesForTree } from "./lib/candidate-api.mjs";
import { inventory } from "./lib/candidate-model.mjs";
import { CI_RECIPE, POLICY, hash } from "./lib/candidate-policy.mjs";
import { Candidates } from "./lib/candidate-service.mjs";

function fixtureManifest(source, control) {
  return {
    format: "opensesame-candidate",
    schema_version: 1,
    source_sha: source,
    candidate_id: `${source}-100-1`,
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
      size: Buffer.byteLength(path),
      sha256: hash(path),
    })),
  };
}

function fixtureApi(ctx, run, source) {
  const gate = (name) => ({
    id: 1,
    name,
    status: "completed",
    conclusion: "success",
    started_at: "2026-10-26T06:00:00Z",
    completed_at: "2026-10-26T09:00:00Z",
  });
  return {
    ctx,
    attempt: async (id) =>
      id === "100"
        ? run
        : {
            ...run,
            path: ".github/workflows/ci.yml",
            event: "push",
            head_sha: source,
            run_attempt: 2,
            status: "completed",
            conclusion: "success",
          },
    jobs: async (id) =>
      id === "100"
        ? [gate("build / Candidate build gate")]
        : ["TypeScript", "Bundle budgets", "Rust"].map(gate),
    main: async () => source,
    ancestor: async () => true,
    compatibleCi: async () => true,
    compatiblePolicy: async () => true,
  };
}

function fixture() {
  const source = "a".repeat(40);
  const control = "b".repeat(40);
  const ctx = {
    repository: POLICY.repository,
    token: "test-token",
    runId: "300",
    runAttempt: "1",
    workflow: ".github/workflows/release-weekly.yml",
    workflowSha: control,
    now: Date.parse("2026-10-26T12:00:00Z"),
  };
  const manifest = fixtureManifest(source, control);
  const bytes = `${JSON.stringify(manifest)}\n`;
  const candidate = {
    source_sha: source,
    candidate_id: manifest.candidate_id,
    run_id: "100",
    run_attempt: "1",
    artifact_id: "200",
    artifact_digest: "1".repeat(64),
    payload_digest: hash(bytes),
  };
  const run = {
    repository: { full_name: ctx.repository },
    head_repository: { full_name: ctx.repository },
    head_branch: "main",
    run_attempt: 1,
    path: ".github/workflows/dev-nightly.yml",
    event: "schedule",
    head_sha: control,
    status: "completed",
    conclusion: "success",
    run_started_at: "2026-10-26T06:00:00Z",
    updated_at: "2026-10-26T10:00:00Z",
  };
  const api = fixtureApi(ctx, run, source);
  let attestations = 0;
  const download = async ({ destination }) => {
    for (const payload of manifest.payloads) {
      await mkdir(dirname(join(destination, payload.path)), {
        recursive: true,
      });
      await writeFile(join(destination, payload.path), payload.path);
    }
    await writeFile(join(destination, "candidate.json"), bytes);
    return {
      created_at: "2026-10-26T08:00:00Z",
      expires_at: "2026-11-30T08:00:00Z",
    };
  };
  const service = new Candidates(ctx, {
    api,
    download,
    provenance: async () => {
      attestations++;
    },
  });
  return {
    service,
    candidate,
    run,
    api,
    ctx,
    attestations: () => attestations,
  };
}

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), "candidate-service-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("acceptance verifies original build provenance after exact source and package checks", async (t) => {
  const fixtureData = fixture();
  await fixtureData.service.verify(fixtureData.candidate, await temporary(t));
  assert.equal(fixtureData.attestations(), 1);
});

test("same-run completed build gate is accepted before controller completion", async (t) => {
  const data = fixture();
  data.ctx.runId = "100";
  data.run.status = "in_progress";
  data.run.conclusion = null;
  await data.service.verify(data.candidate, await temporary(t));
  assert.equal(data.attestations(), 1);
});

test("cross-run incomplete or failed controller cannot authorize reuse", async (t) => {
  for (const status of ["in_progress", "completed"]) {
    const data = fixture();
    data.run.status = status;
    data.run.conclusion = "failure";
    await assert.rejects(
      data.service.verify(data.candidate, await temporary(t)),
      /attempt did not succeed/,
    );
    assert.equal(data.attestations(), 0);
  }
});

test("stale attempt, incompatible policy and missing producer gate fail before acceptance", async (t) => {
  const changes = [
    (data) => {
      data.run.run_attempt = 2;
    },
    (data) => {
      data.api.compatiblePolicy = async () => false;
    },
    (data) => {
      data.api.jobs = async () => [];
    },
  ];
  for (const change of changes) {
    const data = fixture();
    change(data);
    await assert.rejects(
      data.service.verify(data.candidate, await temporary(t)),
    );
    assert.equal(data.attestations(), 0);
  }
});

test("signature verification failure is a release failure, not a warning", async (t) => {
  const data = fixture();
  data.service.provenance = async () => {
    throw new Error("wrong signer");
  };
  await assert.rejects(
    data.service.verify(data.candidate, await temporary(t)),
    /wrong signer/,
  );
});

test("artifact age must fit the original run attempt and current retention", () => {
  const data = fixture();
  assert.throws(
    () =>
      data.service.artifactTime(
        {
          created_at: "2026-10-25T08:00:00Z",
          expires_at: "2026-11-01T00:00:00Z",
        },
        data.run,
      ),
    /earlier attempt/,
  );
  assert.throws(
    () =>
      data.service.artifactTime(
        {
          created_at: "2026-10-26T08:00:00Z",
          expires_at: "2026-10-26T09:00:00Z",
        },
        data.run,
      ),
    /expired/,
  );
});

test("pagination reaching its safety bound fails instead of claiming a partial newest selection", async () => {
  const api = new GitHub(
    { repository: POLICY.repository, token: "test" },
    async () => ({
      ok: true,
      json: async () => ({
        workflow_runs: Array.from({ length: 100 }, (_, id) => ({ id })),
      }),
    }),
  );
  await assert.rejects(
    api.pages("/actions/workflows/ci.yml/runs", "workflow_runs"),
    /incomplete/,
  );
});

test("policy compatibility rejects added files as well as deleted or modified guard code", async () => {
  const initial = new Map([
    [".github/workflows/ci.yml", "blob1"],
    ["scripts/release/candidate.mjs", "blob2"],
  ]);
  const api = new GitHub({ workflowSha: "a".repeat(40) });
  api.policyEntries = async () => policyEntriesForTree(initial);
  api.tree = async () => initial;
  assert.equal(await api.compatiblePolicy("b".repeat(40)), true);
  for (const entries of [
    [...initial, [".github/workflows/new-release-gate.yml", "blob3"]],
    [...initial, [".github/workflows/new-release-gate.yaml", "blob3"]],
    [...initial, ["scripts/release/new-guard.mjs", "blob3"]],
    [...initial, ["tools/mutation/required-thresholds.json", "blob3"]],
    [
      [".github/workflows/ci.yml", "changed"],
      ["scripts/release/candidate.mjs", "blob2"],
    ],
    [[".github/workflows/ci.yml", "blob1"]],
  ]) {
    api.tree = async () => new Map(entries);
    assert.equal(await api.compatiblePolicy("b".repeat(40)), false);
  }
  api.tree = async () => new Map([...initial, ["docs/unrelated.md", "blob3"]]);
  assert.equal(await api.compatiblePolicy("b".repeat(40)), true);
});

test("CI helper additions, changes and removals invalidate the policy hash and earlier evidence", async () => {
  const original = new Map([
    [".github/workflows/ci.yml", "workflow"],
    ["scripts/ci/prepare-dbus.sh", "dbus-helper"],
    ["scripts/lib/ci-pages-build.mjs", "pages-helper"],
    ["scripts/lib/ci-bundle-shards.json", "shard-config"],
    ["scripts/lib/json-boundary.mjs", "json-helper"],
    ["scripts/lib/pr-signatures.mjs", "signature-helper"],
    ["scripts/lib/pages-release.mjs", "release-helper"],
    ["package.json", "qualification-commands"],
  ]);
  let control = original;
  const api = new GitHub({ workflowSha: "a".repeat(40) });
  api.policyEntries = async () => policyEntriesForTree(control);
  api.tree = async () => original;
  const originalHash = await api.policyHash();
  for (const path of [
    "scripts/ci/prepare-dbus.sh",
    "scripts/ci/new-helper.py",
    "scripts/lib/ci-pages-build.mjs",
    "scripts/lib/ci-bundle-shards.json",
    "scripts/lib/json-boundary.mjs",
    "scripts/lib/pr-signatures.mjs",
    "scripts/lib/pages-release.mjs",
    "package.json",
  ]) {
    control = new Map([...original, [path, "changed"]]);
    assert.notEqual(await api.policyHash(), originalHash);
    assert.equal(await api.compatiblePolicy("b".repeat(40)), false);
  }
  control = new Map(original);
  control.delete("scripts/ci/prepare-dbus.sh");
  assert.notEqual(await api.policyHash(), originalHash);
  assert.equal(await api.compatiblePolicy("b".repeat(40)), false);
  control = new Map([
    ...original,
    ["scripts/ci/prepare-dbus.test.mjs", "test-only"],
    ["scripts/lib/ci-pages-build.test.mjs", "test-only"],
  ]);
  assert.equal(await api.policyHash(), originalHash);
  assert.equal(await api.compatiblePolicy("b".repeat(40)), true);
});

test("scanner configuration, ignores and helpers are part of policy compatibility", async () => {
  const policies = [
    ".github/codeql/codeql-config.yml",
    ".github/codeql/custom/queries.qls",
    ".gitleaks.toml",
    ".gitleaksignore",
    ".osv-scanner.toml",
    ".cargo/audit.toml",
    ".cargo/config.toml",
    "deny.toml",
    "osv-scanner.toml",
    ".semgrepignore",
    ".semgrep/rules.yml",
    "apps/.semgrepignore",
    ".gitignore",
    "apps/.gitignore",
    "scripts/lib/audit-directory.sh",
    "scripts/security/map-composed-go-sarif.mjs",
    "scripts/security/gitleaks-reviewed-working-tree.json",
  ];
  const controller = new Map(policies.map((path) => [path, `blob:${path}`]));
  const api = new GitHub({ workflowSha: "a".repeat(40) });
  api.policyEntries = async () => policyEntriesForTree(controller);
  const expectedHash = await api.policyHash();
  for (const path of policies) {
    for (const value of [null, "changed"]) {
      const candidate = new Map(controller);
      if (value === null) candidate.delete(path);
      else candidate.set(path, value);
      api.tree = async () => candidate;
      assert.equal(await api.compatiblePolicy("b".repeat(40)), false, path);
    }
  }
  api.tree = async () => new Map(controller);
  assert.equal(await api.compatiblePolicy("b".repeat(40)), true);
  controller.set(".semgrepignore", "new-controller-policy");
  assert.notEqual(await api.policyHash(), expectedHash);
  for (const path of policies) {
    const without = new Map(controller);
    without.delete(path);
    api.policyEntries = async () => policyEntriesForTree(without);
    api.tree = async () => controller;
    assert.equal(await api.compatiblePolicy("b".repeat(40)), false, path);
  }
  api.tree = async () => new Map([...controller, ["docs/unrelated.md", "new"]]);
  api.policyEntries = async () => policyEntriesForTree(controller);
  assert.equal(await api.compatiblePolicy("b".repeat(40)), true);
});

test("missing required controller scanner configuration fails closed", async () => {
  const api = new GitHub({ workflowSha: "a".repeat(40) });
  const required = [
    ".github/codeql/codeql-config.yml",
    ".gitleaks.toml",
    ".cargo/audit.toml",
    "deny.toml",
    "osv-scanner.toml",
  ];
  const controller = new Map(
    [...CI_RECIPE, ...required].map((path) => [path, "blob"]),
  );
  api.tree = async () => controller;
  assert.ok((await api.policyEntries()).length >= 12);
  for (const path of required) {
    const incomplete = new Map(controller);
    incomplete.delete(path);
    api.tree = async () => incomplete;
    await assert.rejects(
      api.policyEntries(),
      /Current policy is incomplete/,
      path,
    );
  }
});
