import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyReleaseTagPolicies,
  pagesPolicyChanges,
  rulesetAction,
  selectRuleset,
} from "./github-governance.mjs";

const root = new URL("../../", import.meta.url);
const policy = JSON.parse(
  readFileSync(new URL("ops/github/default-branch.json", root), "utf8"),
);

it("verifies the checked-in Gradle bootstrap against the official wrapper checksum", () => {
  const wrapper = readFileSync(
    new URL("gradle/wrapper/gradle-wrapper.jar", root),
  );
  // https://services.gradle.org/distributions/gradle-8.13-wrapper.jar.sha256
  expect(createHash("sha256").update(wrapper).digest("hex")).toBe(
    "81a82aaea5abcc8ff68b3dfcb58b3c3c429378efd98e7433460610fecd7ae45f",
  );
  const properties = readFileSync(
    new URL("gradle/wrapper/gradle-wrapper.properties", root),
    "utf8",
  );
  expect(properties).toMatch(/^distributionSha256Sum=[a-f0-9]{64}$/m);
  expect(properties).toContain("gradle-8.13-bin.zip");
});

describe("repository governance ownership", () => {
  it("updates only the named policy and refuses ambiguous ownership", () => {
    expect(selectRuleset([{ name: "unrelated" }], policy.name)).toBeUndefined();
    expect(() => selectRuleset([policy, policy], policy.name)).toThrow(
      "ambiguous",
    );
    expect(() => rulesetAction({ name: "unrelated" }, policy)).toThrow(
      "ownership",
    );
    expect(rulesetAction(null, policy)).toBe("create");
    expect(rulesetAction({ ...policy, id: 1, _links: {} }, policy)).toBe(
      "none",
    );
    expect(rulesetAction({ ...policy, enforcement: "disabled" }, policy)).toBe(
      "update",
    );
  });
});

describe("repository governance default-branch rules", () => {
  it("requires current Actions checks without impossible sole-owner approval", () => {
    expect(policy.bypass_actors).toEqual([]);
    expect(policy.conditions.ref_name).toEqual({
      include: ["~DEFAULT_BRANCH"],
      exclude: [],
    });
    expect(policy.rules.map((rule) => rule.type)).toEqual([
      "deletion",
      "non_fast_forward",
      "required_linear_history",
      "required_signatures",
      "pull_request",
      "required_status_checks",
    ]);
    const checks = policy.rules.find(
      (rule) => rule.type === "required_status_checks",
    ).parameters;
    expect(checks.strict_required_status_checks_policy).toBe(true);
    expect(checks.required_status_checks).toEqual([
      { context: "TypeScript", integration_id: 15368 },
      { context: "Bundle budgets", integration_id: 15368 },
      { context: "Rust", integration_id: 15368 },
    ]);
    const review = policy.rules.find(
      (rule) => rule.type === "pull_request",
    ).parameters;
    expect(review.required_review_thread_resolution).toBe(true);
    expect(review.required_approving_review_count).toBe(0);
    expect(review.require_code_owner_review).toBe(false);
  });

  it("uses strict current-head checks on a personal repository without a merge queue", () => {
    expect(policy.rules.some((rule) => rule.type === "merge_queue")).toBe(
      false,
    );
    expect(
      policy.rules.find((rule) => rule.type === "required_status_checks")
        .parameters.strict_required_status_checks_policy,
    ).toBe(true);
  });
});

const tags = JSON.parse(
  readFileSync(new URL("ops/github/release-tags.json", root), "utf8"),
);

const tagCreation = JSON.parse(
  readFileSync(new URL("ops/github/release-tag-creation.json", root), "utf8"),
);

describe("repository governance release tags", () => {
  it("lets only a repository admin move or delete a v* tag", () => {
    expect(tags.target).toBe("tag");
    expect(tags.enforcement).toBe("active");
    expect(tags.name).not.toBe(policy.name);
    expect(tags.conditions.ref_name).toEqual({
      include: ["refs/tags/v*"],
      exclude: [],
    });
    expect(tags.rules.map((rule) => rule.type).sort()).toEqual([
      "deletion",
      "update",
    ]);
    // Role 5 is admin: Actions cannot move or delete an existing tag.
    expect(tags.bypass_actors).toEqual([
      { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
    ]);
  });

  it("is owned and compared like the default-branch ruleset", () => {
    expect(rulesetAction(null, tags)).toBe("create");
    expect(rulesetAction({ ...tags, id: 2, _links: {} }, tags)).toBe("none");
    expect(rulesetAction({ ...tags, enforcement: "disabled" }, tags)).toBe(
      "update",
    );
    expect(() => rulesetAction(policy, tags)).toThrow("ownership");
    // GitHub may answer an `update` rule with parameters nobody sent
    // (update_allows_fetch_and_merge on the branch form), which is not drift.
    const echoed = tags.rules.map((rule) =>
      rule.type === "update"
        ? { ...rule, parameters: { update_allows_fetch_and_merge: false } }
        : rule,
    );
    expect(rulesetAction({ ...tags, rules: echoed, id: 2 }, tags)).toBe("none");
    // The same latitude is not given to the default-branch rules.
    const branchEchoed = policy.rules.map((rule) =>
      rule.type === "pull_request"
        ? { ...rule, parameters: { ...rule.parameters, extra: true } }
        : rule,
    );
    expect(
      rulesetAction({ ...policy, rules: branchEchoed, id: 1 }, policy),
    ).toBe("update");
    // Both rulesets are told apart by name in one listing.
    const live = [
      { ...policy, id: 1 },
      { ...tags, id: 2 },
    ];
    expect(selectRuleset(live, tags.name).id).toBe(2);
    expect(selectRuleset(live, policy.name).id).toBe(1);
  });
});

describe("repository governance pages and workflows", () => {
  it("restricts Pages to the default branch, including tag/name confusion", () => {
    const branches = [
      { id: 1, type: "branch", name: "main" },
      { id: 2, type: "branch", name: "gh-pages" },
    ];
    expect(pagesPolicyChanges(branches, "main")).toEqual({
      create: false,
      remove: [branches[1]],
    });
    expect(
      pagesPolicyChanges([{ id: 3, type: "tag", name: "main" }], "main"),
    ).toEqual({
      create: true,
      remove: [{ id: 3, type: "tag", name: "main" }],
    });
    expect(pagesPolicyChanges([branches[0]], "main")).toEqual({
      create: false,
      remove: [],
    });
  });

  it("pins every external action and never retains checkout credentials", () => {
    const directory = new URL(".github/workflows/", root);
    for (const name of readdirSync(directory).filter((file) =>
      /\.ya?ml$/.test(file),
    )) {
      const yaml = readFileSync(new URL(name, directory), "utf8");
      for (const match of yaml.matchAll(/uses:\s*(\S+)/g)) {
        if (match[1].startsWith("./")) continue;
        expect(match[1]).toMatch(/^[\w./-]+@[a-f0-9]{40}$/);
      }
      for (const checkout of yaml.split(/uses: actions\/checkout@/).slice(1)) {
        expect(checkout.split(/\n\s+- /)[0]).toMatch(
          /persist-credentials: false/,
        );
      }
    }
  });
});

it("gates main artifact promotion with the owner review and no admin bypass", () => {
  const environment = JSON.parse(
    readFileSync(new URL("ops/github/release-environment.json", root), "utf8"),
  );
  const branch = JSON.parse(
    readFileSync(
      new URL("ops/github/release-environment-branches.json", root),
      "utf8",
    ),
  );
  expect(environment).toEqual({
    wait_timer: 0,
    prevent_self_review: false,
    reviewers: [{ type: "User", id: 145080887 }],
    can_admins_bypass: false,
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  });
  expect(branch).toEqual({ name: "main", type: "branch" });
  const publish = readFileSync(
    new URL(".github/workflows/release-publish.yml", root),
    "utf8",
  );
  expect(publish).toContain('[ "$GITHUB_REF" = refs/heads/main ]');
  expect(publish).toMatch(/environment:\n +name: release/);
});

it("grants Actions only new-tag creation while keeping tag mutation owner-only", () => {
  expect(tagCreation.name).toBe("opensesame-release-tag-creation");
  expect(tagCreation.target).toBe("tag");
  expect(tagCreation.enforcement).toBe("active");
  expect(tagCreation.conditions).toEqual(tags.conditions);
  expect(tagCreation.rules).toEqual([{ type: "creation" }]);
  expect(tagCreation.bypass_actors).toEqual([
    { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
    { actor_id: 15368, actor_type: "Integration", bypass_mode: "always" },
  ]);
  expect(tags.rules).toEqual([{ type: "update" }, { type: "deletion" }]);
  expect(tags.bypass_actors).toEqual([
    { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
  ]);
  expect(policy.bypass_actors).toEqual([]);
  expect(selectRuleset([tags, tagCreation], tagCreation.name)).toBe(
    tagCreation,
  );
  expect(rulesetAction({ ...tagCreation, id: 3 }, tagCreation)).toBe("none");
  expect(
    rulesetAction(
      { ...tagCreation, rules: [...tagCreation.rules, { type: "update" }] },
      tagCreation,
    ),
  ).toBe("update");
});

function tagPolicyWriter(initial = []) {
  const writes = [];
  const current = new Map(initial.map((spec) => [spec.name, spec]));
  const write = (spec, live, action) => {
    if (action === "none") return live;
    const saved = {
      ...structuredClone(spec),
      id: live?.id ?? writes.length + 1,
    };
    writes.push(saved);
    current.set(spec.name, saved);
    // At every activation step Actions remains unable to update/delete tags.
    for (const operation of ["update", "deletion"]) {
      expect(
        [...current.values()].some(
          (rule) =>
            rule.rules.some(({ type }) => type === operation) &&
            !rule.bypass_actors.some(
              (actor) =>
                actor.actor_type === "Integration" && actor.actor_id === 15368,
            ),
        ),
      ).toBe(true);
    }
    return saved;
  };
  return { writes, current, write };
}

it("bootstraps immutable tags before first enabling app creation, and applies idempotently", () => {
  const { writes, current, write } = tagPolicyWriter();
  applyReleaseTagPolicies(write, null, null, tags, tagCreation);
  expect(
    writes.map((spec) => [spec.name, spec.rules.map(({ type }) => type)]),
  ).toEqual([
    [tags.name, ["creation", "update", "deletion"]],
    [tagCreation.name, ["creation"]],
    [tags.name, ["update", "deletion"]],
  ]);
  expect(writes[0].bypass_actors).toEqual(tags.bypass_actors);
  applyReleaseTagPolicies(
    write,
    current.get(tags.name),
    current.get(tagCreation.name),
    tags,
    tagCreation,
  );
  expect(writes).toHaveLength(3);
});

it("does not drop legacy creation protection if installing the creation-only policy fails", () => {
  const original = {
    ...tags,
    id: 2,
    rules: [{ type: "creation" }, ...tags.rules],
  };
  const writes = [];
  expect(() =>
    applyReleaseTagPolicies(
      (spec) => {
        writes.push(spec.name);
        throw new Error("HTTP 403");
      },
      original,
      null,
      tags,
      tagCreation,
    ),
  ).toThrow("HTTP 403");
  expect(writes).toEqual([tagCreation.name]);
  expect(original.rules[0].type).toBe("creation");
});

it("installs the creation-only policy before dropping the legacy creation restriction", () => {
  const original = {
    ...tags,
    id: 2,
    rules: [{ type: "creation" }, ...tags.rules],
  };
  const { writes, write } = tagPolicyWriter([original]);
  applyReleaseTagPolicies(write, original, null, tags, tagCreation);
  expect(writes.map((spec) => spec.name)).toEqual([
    tagCreation.name,
    tags.name,
  ]);
  expect(writes[1].rules).toEqual([{ type: "update" }, { type: "deletion" }]);
  expect(writes[1].bypass_actors).toEqual(tags.bypass_actors);
});
