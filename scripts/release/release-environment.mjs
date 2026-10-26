#!/usr/bin/env node
// Verify existing protection; never create an environment or relax its policy.
import { pathToFileURL } from "node:url";
import { GitHub } from "./lib/candidate-api.mjs";
import { POLICY, demand } from "./lib/candidate-policy.mjs";

const requireProtection = (condition, detail) =>
  demand(
    condition,
    `Release environment protection missing or mismatched: ${detail}. Configure the reviewed ops/github/release-environment.json and release-environment-branches.json settings before promotion`,
  );

export async function assertReleaseEnvironment(api) {
  let environment;
  let branches;
  try {
    environment = await api.get("/environments/release");
    branches = await api.pages(
      "/environments/release/deployment-branch-policies",
      "branch_policies",
    );
  } catch (error) {
    throw new Error(
      "Release environment protection could not be read. Promotion is blocked; configure the reviewed release environment and grant Actions read access",
      { cause: error },
    );
  }
  requireProtection(
    environment?.name === "release",
    "release environment must already exist",
  );
  requireProtection(
    environment.can_admins_bypass === false,
    "admin bypass must be disabled",
  );
  const policy = environment.deployment_branch_policy;
  requireProtection(
    policy?.protected_branches === false &&
      policy.custom_branch_policies === true,
    "custom deployment branch restrictions must be enabled",
  );
  requireProtection(
    Array.isArray(branches) &&
      branches.length === 1 &&
      branches[0]?.name === "main" &&
      branches[0]?.type === "branch",
    "only the main branch may deploy; tags and wildcard policies are refused",
  );
  requireProtection(
    Array.isArray(environment.protection_rules),
    "protection rules are absent",
  );
  const reviewers = environment.protection_rules.filter(
    (rule) => rule?.type === "required_reviewers",
  );
  requireProtection(
    reviewers.length === 1,
    "one required-reviewer rule is required",
  );
  const rule = reviewers[0];
  requireProtection(
    rule.prevent_self_review === false,
    "the approved owner self-review policy must be retained",
  );
  requireProtection(
    Array.isArray(rule.reviewers) &&
      rule.reviewers.length === 1 &&
      rule.reviewers[0]?.type === "User" &&
      rule.reviewers[0]?.reviewer?.id === 145080887,
    "only the approved owner (User 145080887) may approve a release",
  );
}

export async function checkReleaseEnvironment({ repository, token, api }) {
  demand(
    repository === POLICY.repository,
    "Untrusted release environment repository",
  );
  demand(
    typeof token === "string" && token.length > 0,
    "Release environment inspection requires an authenticated Actions token",
  );
  await assertReleaseEnvironment(api || new GitHub({ repository, token }));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  demand(
    process.env.GITHUB_REF === "refs/heads/main",
    "Release environment inspection requires the trusted main controller",
  );
  await checkReleaseEnvironment({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN,
  });
}
