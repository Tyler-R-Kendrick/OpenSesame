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

describe("repository governance", () => {
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
