import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
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

describe("repository governance release tags", () => {
  it("lets only a repository admin create, move or delete a v* tag", () => {
    expect(tags.target).toBe("tag");
    expect(tags.enforcement).toBe("active");
    expect(tags.name).not.toBe(policy.name);
    expect(tags.conditions.ref_name).toEqual({
      include: ["refs/tags/v*"],
      exclude: [],
    });
    expect(tags.rules.map((rule) => rule.type).sort()).toEqual([
      "creation",
      "deletion",
      "update",
    ]);
    // Role 5 is admin: the owner cuts the release, nobody else may.
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
