import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { GitHub } from "./lib/candidate-api.mjs";
import { POLICY } from "./lib/candidate-policy.mjs";
import {
  assertReleaseEnvironment,
  checkReleaseEnvironment,
} from "./release-environment.mjs";

function fixture() {
  const state = {
    environment: {
      name: "release",
      can_admins_bypass: false,
      deployment_branch_policy: {
        protected_branches: false,
        custom_branch_policies: true,
      },
      protection_rules: [
        {
          type: "required_reviewers",
          prevent_self_review: false,
          reviewers: [
            { type: "User", reviewer: { id: 145080887, login: "owner" } },
          ],
        },
      ],
    },
    branches: [{ id: 1, name: "main", type: "branch" }],
    status: 200,
    branchStatus: 200,
    calls: [],
  };
  const api = new GitHub(
    { repository: POLICY.repository, token: "fixture-token" },
    async (url, options) => {
      state.calls.push({ url, options });
      assert.equal(
        options.method ?? "GET",
        "GET",
        "inspection cannot mutate policy",
      );
      assert.equal(new URL(url).origin, "https://api.github.com");
      assert.equal(options.headers.Authorization, "Bearer fixture-token");
      const path = new URL(url).pathname;
      let body;
      if (path === `/repos/${POLICY.repository}/environments/release`)
        body = state.environment;
      else if (
        path ===
        `/repos/${POLICY.repository}/environments/release/deployment-branch-policies`
      )
        body = {
          total_count: state.branches?.length,
          branch_policies: state.branches,
        };
      else assert.fail(`Unexpected request: ${path}`);
      return new Response(JSON.stringify(body), {
        status: path.endsWith("deployment-branch-policies")
          ? state.branchStatus
          : state.status,
        headers: { "content-type": "application/json" },
      });
    },
  );
  return { state, api };
}

test("reads the existing environment and exact main branch policy without writing", async () => {
  const { state, api } = fixture();
  await checkReleaseEnvironment({
    repository: POLICY.repository,
    token: "fixture-token",
    api,
  });
  assert.equal(state.calls.length, 2);
  const spec = JSON.parse(
    readFileSync(
      new URL("../../ops/github/release-environment.json", import.meta.url),
    ),
  );
  const branch = JSON.parse(
    readFileSync(
      new URL(
        "../../ops/github/release-environment-branches.json",
        import.meta.url,
      ),
    ),
  );
  assert.equal(state.environment.can_admins_bypass, spec.can_admins_bypass);
  assert.deepEqual(
    state.environment.deployment_branch_policy,
    spec.deployment_branch_policy,
  );
  const rule = state.environment.protection_rules[0];
  assert.equal(rule.prevent_self_review, spec.prevent_self_review);
  assert.deepEqual(
    rule.reviewers.map(({ type, reviewer }) => ({ type, id: reviewer.id })),
    spec.reviewers,
  );
  assert.deepEqual(
    { name: state.branches[0].name, type: state.branches[0].type },
    branch,
  );
});

test("an absent environment, denied inspection or server error cannot fall back to unprotected publication", async () => {
  for (const status of [401, 403, 404, 500]) {
    const { state, api } = fixture();
    state.status = status;
    await assert.rejects(assertReleaseEnvironment(api), /could not be read/);
    assert.equal(state.calls.length, 1);
  }
});

test("denied deployment branch inspection also blocks publication", async () => {
  const { state, api } = fixture();
  state.branchStatus = 403;
  await assert.rejects(assertReleaseEnvironment(api), /could not be read/);
  assert.equal(state.calls.length, 2);
});

test("unprotected, bypassable and differently approved environments fail closed", async () => {
  for (const mutate of [
    (s) => {
      s.environment = null;
    },
    (s) => {
      s.environment.name = "other";
    },
    (s) => {
      s.environment.can_admins_bypass = true;
    },
    (s) => {
      s.environment.can_admins_bypass = undefined;
    },
    (s) => {
      s.environment.protection_rules = [];
    },
    (s) => {
      s.environment.protection_rules = undefined;
    },
    (s) => {
      s.environment.protection_rules[0].prevent_self_review = true;
    },
    (s) => {
      s.environment.protection_rules[0].prevent_self_review = undefined;
    },
    (s) => {
      s.environment.protection_rules[0].reviewers = [];
    },
    (s) => {
      s.environment.protection_rules[0].reviewers[0].reviewer.id = 7;
    },
    (s) => {
      s.environment.protection_rules[0].reviewers[0].type = "Team";
    },
    (s) => {
      s.environment.protection_rules[0].reviewers.push({
        type: "User",
        reviewer: { id: 7 },
      });
    },
    (s) => {
      s.environment.protection_rules.push(
        structuredClone(s.environment.protection_rules[0]),
      );
    },
  ]) {
    const { state, api } = fixture();
    mutate(state);
    await assert.rejects(
      assertReleaseEnvironment(api),
      /protection missing or mismatched/,
    );
  }
});

test("unrestricted, tag-only, wildcard and extra deployment branch policies fail closed", async () => {
  for (const mutate of [
    (s) => {
      s.environment.deployment_branch_policy = null;
    },
    (s) => {
      s.environment.deployment_branch_policy.protected_branches = true;
    },
    (s) => {
      s.environment.deployment_branch_policy.custom_branch_policies = false;
    },
    (s) => {
      s.branches = [];
    },
    (s) => {
      s.branches[0].type = "tag";
    },
    (s) => {
      s.branches[0].name = "v*";
    },
    (s) => {
      s.branches[0].name = "*";
    },
    (s) => {
      s.branches.push({ name: "dev", type: "branch" });
    },
  ]) {
    const { state, api } = fixture();
    mutate(state);
    await assert.rejects(
      assertReleaseEnvironment(api),
      /protection missing or mismatched/,
    );
  }
  const { state, api } = fixture();
  state.branches = null;
  await assert.rejects(assertReleaseEnvironment(api), /could not be read/);
});

test("every invocation re-reads live settings so protection removal after approval is rejected", async () => {
  const { state, api } = fixture();
  await assertReleaseEnvironment(api);
  state.environment.protection_rules = [];
  await assert.rejects(
    assertReleaseEnvironment(api),
    /protection missing or mismatched/,
  );
  assert.equal(state.calls.length, 4);
});

test("inspection refuses untrusted repositories and missing authentication", async () => {
  const { state, api } = fixture();
  await assert.rejects(
    checkReleaseEnvironment({
      repository: "other/repo",
      token: "fixture-token",
      api,
    }),
    /Untrusted/,
  );
  await assert.rejects(
    checkReleaseEnvironment({ repository: POLICY.repository, token: "", api }),
    /authenticated/,
  );
  assert.equal(state.calls.length, 0);
});

test("all release jobs inspect protection before candidate verification or side effects", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/release-publish.yml", import.meta.url),
    "utf8",
  );
  for (const name of ["admission", "stage", "approval", "pages", "publish"]) {
    const job =
      workflow.split(`\n  ${name}:`)[1]?.split(/\n {2}[a-z][a-z0-9_-]*:/)[0] ??
      "";
    const guard = job.indexOf(
      "run: node .ci-control/scripts/release/release-environment.mjs",
    );
    const verify = job.indexOf(
      "run: node .ci-control/scripts/release/candidate.mjs verify-promotion",
    );
    assert.ok(
      guard >= 0 && verify > guard,
      `${name} must fail before candidate admission or effects`,
    );
    assert.match(job, /actions: read/);
  }
  const pages = workflow.split("\n  pages:")[1]?.split("\n  publish:")[0] ?? "";
  const immediate = pages.indexOf(
    "- name: Recheck release protection immediately before deployment",
  );
  const deployment = pages.indexOf(
    "- name: Deploy the verified original Pages artifact",
  );
  assert.ok(immediate >= 0 && deployment > immediate);
  const publisher = readFileSync(
    new URL("./publish-release.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(
    publisher.indexOf("await checkReleaseEnvironment(") <
      publisher.indexOf("verifyPromotionProvenance({"),
  );
});
