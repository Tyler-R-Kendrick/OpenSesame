import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  pagesPolicyChanges,
  rulesetAction,
  selectRuleset,
} from "../../scripts/lib/github-governance.mjs";

const repository = "Tyler-R-Kendrick/OpenSesame";
const root = `repos/${repository}`;
const expected = JSON.parse(
  readFileSync(new URL("./default-branch.json", import.meta.url), "utf8"),
);
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
  const match = selectRuleset(list(`${root}/rulesets`), expected.name);
  const current = match ? api(`${root}/rulesets/${match.id}`) : null;
  const environment = api(`${root}/environments/github-pages`);
  const branches = list(
    `${root}/environments/github-pages/deployment-branch-policies`,
    "branch_policies",
  );
  return { repo, current, environment, branches };
}

let state = inspect();
const action = rulesetAction(state.current, expected);
const pages = pagesPolicyChanges(state.branches, state.repo.default_branch);
console.log(
  JSON.stringify({
    repository,
    mode,
    ruleset: action,
    pages,
    auto_merge: state.repo.allow_auto_merge,
  }),
);

if (mode === "--apply") {
  if (action !== "none") {
    api(
      action === "create"
        ? `${root}/rulesets`
        : `${root}/rulesets/${state.current.id}`,
      action === "create" ? "POST" : "PUT",
      expected,
    );
  }
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
      ...expected,
      pages_branch: state.repo.default_branch,
      auto_merge: true,
    }),
  );
}
