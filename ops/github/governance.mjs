import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  applyReleaseTagPolicies,
  pagesPolicyChanges,
  rulesetAction,
  selectRuleset,
} from "../../scripts/lib/github-governance.mjs";

const repository = "Tyler-R-Kendrick/OpenSesame";
const root = `repos/${repository}`;
const readPolicy = (file) =>
  JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
const expected = readPolicy("./default-branch.json");
// Keep creation exceptions separate from protected tag updates/deletions.
const releaseTags = readPolicy("./release-tags.json");
const releaseTagCreation = readPolicy("./release-tag-creation.json");
const mode = process.argv[2] ?? "--dry-run";
if (
  !["--dry-run", "--apply", "--verify"].includes(mode) ||
  process.argv.length > 3
) {
  throw new Error(
    "Usage: node ops/github/governance.mjs [--dry-run|--apply|--verify]",
  );
}

function api(path, method = "GET", body = undefined) {
  const args = ["api", path, "--method", method];
  if (body) args.push("--input", "-");
  let output;
  try {
    output = execFileSync("gh", args, {
      encoding: "utf8",
      input: body ? JSON.stringify(body) : undefined,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    // gh diagnostics can include returned configuration; do not print them.
    throw new Error(
      `GitHub ${method} ${path} failed; check repository administration permission`,
    );
  }
  return output.trim() ? JSON.parse(output) : null;
}

function list(path, field) {
  const result = [];
  for (let page = 1; page <= 100; page++) {
    const response = api(`${path}?per_page=100&page=${page}`);
    const entries = field ? response[field] : response;
    if (!Array.isArray(entries))
      throw new Error("invalid GitHub list response");
    result.push(...entries);
    if (entries.length < 100) return result;
  }
  throw new Error("GitHub pagination limit exceeded");
}

function inspect() {
  const repo = api(root);
  const live = list(`${root}/rulesets`);
  const detail = (policy) => {
    const match = selectRuleset(live, policy.name);
    return match ? api(`${root}/rulesets/${match.id}`) : null;
  };
  const current = detail(expected);
  const currentTags = detail(releaseTags);
  const currentTagCreation = detail(releaseTagCreation);
  const environment = api(`${root}/environments/github-pages`);
  const branches = list(
    `${root}/environments/github-pages/deployment-branch-policies`,
    "branch_policies",
  );
  return {
    repo,
    current,
    currentTags,
    currentTagCreation,
    environment,
    branches,
  };
}

let state = inspect();
const action = rulesetAction(state.current, expected);
const tagsAction = rulesetAction(state.currentTags, releaseTags);
const creationAction = rulesetAction(
  state.currentTagCreation,
  releaseTagCreation,
);
const pages = pagesPolicyChanges(state.branches, state.repo.default_branch);
console.log(
  JSON.stringify({
    repository,
    mode,
    ruleset: action,
    release_tags: tagsAction,
    release_tag_creation: creationAction,
    release_tag_bootstrap: state.currentTags ? "none" : "owner-only-first",
    pages,
    auto_merge: state.repo.allow_auto_merge,
  }),
);

function writeRuleset(policy, current, todo) {
  if (todo === "none") return;
  return api(
    todo === "create" ? `${root}/rulesets` : `${root}/rulesets/${current.id}`,
    todo === "create" ? "POST" : "PUT",
    policy,
  );
}

if (mode === "--apply") {
  writeRuleset(expected, state.current, action);
  if (!state.repo.allow_auto_merge)
    api(root, "PATCH", { allow_auto_merge: true });
  // Preserve reviewers, wait timer, bypass policy and custom deployment rules.
  api(`${root}/environments/github-pages`, "PUT", {
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
    prevent_self_review:
      state.environment.protection_rules?.some(
        (rule) => rule.prevent_self_review,
      ) ?? false,
    reviewers:
      state.environment.protection_rules
        ?.flatMap((rule) => rule.reviewers ?? [])
        .map(({ type, reviewer }) => ({ type, id: reviewer.id })) ?? [],
    wait_timer:
      state.environment.protection_rules?.find(
        (rule) => rule.type === "wait_timer",
      )?.wait_timer ?? 0,
    can_admins_bypass: state.environment.can_admins_bypass ?? false,
  });
  const endpoint = `${root}/environments/github-pages/deployment-branch-policies`;
  if (pages.create)
    api(endpoint, "POST", { name: state.repo.default_branch, type: "branch" });
  for (const policy of pages.remove) api(`${endpoint}/${policy.id}`, "DELETE");
  // Keep branch/Pages work independent of an unsupported tag configuration.
  // First activation bootstraps owner-only protection; the creation exception
  // is installed before removing creation from the old combined ruleset.
  try {
    applyReleaseTagPolicies(
      writeRuleset,
      state.currentTags,
      state.currentTagCreation,
      releaseTags,
      releaseTagCreation,
    );
  } catch (error) {
    console.error(
      `release tag rulesets were not fully written: ${error.message}`,
    );
  }
  state = inspect();
}

if (mode !== "--dry-run") {
  const remaining = pagesPolicyChanges(
    state.branches,
    state.repo.default_branch,
  );
  const branch = api(
    `${root}/branches/${encodeURIComponent(state.repo.default_branch)}`,
  );
  if (
    rulesetAction(state.current, expected) !== "none" ||
    rulesetAction(state.currentTags, releaseTags) !== "none" ||
    rulesetAction(state.currentTagCreation, releaseTagCreation) !== "none" ||
    !branch.protected ||
    !state.repo.allow_auto_merge ||
    remaining.create ||
    remaining.remove.length ||
    !state.environment.deployment_branch_policy?.custom_branch_policies ||
    state.environment.deployment_branch_policy.protected_branches
  ) {
    throw new Error(
      "GitHub governance verification failed; inspect drift before retrying",
    );
  }
  console.log(
    JSON.stringify({
      verified: true,
      ruleset_id: state.current.id,
      release_tags_ruleset_id: state.currentTags.id,
      release_tag_creation_ruleset_id: state.currentTagCreation.id,
      ...expected,
      pages_branch: state.repo.default_branch,
      auto_merge: true,
    }),
  );
}
