import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/codeql.yml", import.meta.url),
  "utf8",
);
const guard = workflow.match(
  /- name: Require successful analysis on the trusted release controller\n[\s\S]*? {8}run: \|\n([\s\S]*?)(?= {6}- name:)/,
);
assert.ok(guard, "the release controller guard must be present");
const command = guard[1]
  .split("\n")
  .map((line) => line.replace(/^ {10}/, ""))
  .join("\n");

const repository = "OpenSesame-Labs/OpenSesame";
const controller = "a".repeat(40);
const called = {
  workflow_repository: repository,
  workflow_sha: controller,
  workflow_file_path: ".github/workflows/codeql.yml",
};
const env = {
  ...process.env,
  GITHUB_REPOSITORY: repository,
  GITHUB_REF: "refs/heads/main",
  CONTROLLER_SHA: controller,
  SOURCE_SHA: "b".repeat(40),
  ANALYZE_RESULT: "success",
  NATIVE_GO_RESULT: "success",
  CALLER_WORKFLOW_REF: `${repository}/.github/workflows/release-weekly.yml@refs/heads/main`,
  CALLED_JOB_CONTEXT: JSON.stringify(called),
};

function check(overrides = {}) {
  const result = spawnSync("bash", ["-e", "-c", command], {
    env: { ...env, ...overrides },
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  return result.status;
}

test("only the same-commit main release controller can qualify CodeQL evidence", () => {
  assert.equal(check(), 0);
  for (const overrides of [
    { GITHUB_REF: "refs/heads/branch" },
    { GITHUB_REPOSITORY: "other/repository" },
    { SOURCE_SHA: "invalid" },
    { CONTROLLER_SHA: "invalid" },
    { ANALYZE_RESULT: "failure" },
    { NATIVE_GO_RESULT: "failure" },
    { NATIVE_GO_RESULT: "skipped" },
    {
      CALLER_WORKFLOW_REF: `${repository}/.github/workflows/other.yml@refs/heads/main`,
    },
    {
      CALLED_JOB_CONTEXT: JSON.stringify({
        ...called,
        workflow_repository: "other/repository",
      }),
    },
    {
      CALLED_JOB_CONTEXT: JSON.stringify({
        ...called,
        workflow_sha: "c".repeat(40),
      }),
    },
    {
      CALLED_JOB_CONTEXT: JSON.stringify({
        ...called,
        workflow_file_path: ".github/workflows/other.yml",
      }),
    },
    { CALLED_JOB_CONTEXT: "{}" },
    { CALLED_JOB_CONTEXT: "invalid" },
  ]) {
    assert.notEqual(check(overrides), 0, JSON.stringify(overrides));
  }
});
