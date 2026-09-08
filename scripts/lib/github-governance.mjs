import { isDeepStrictEqual } from "node:util";

/** Ignore server-owned metadata, never policy fields. */
export function policyView(policy) {
  return Object.fromEntries(
    [
      "name",
      "target",
      "enforcement",
      "bypass_actors",
      "conditions",
      "rules",
    ].map((key) => [key, policy[key]]),
  );
}

export function rulesetAction(current, expected) {
  if (!current) return "create";
  if (current.name !== expected.name)
    throw new Error("ruleset ownership mismatch");
  return isDeepStrictEqual(policyView(current), policyView(expected))
    ? "none"
    : "update";
}

export function selectRuleset(rulesets, name) {
  const matches = rulesets.filter((rule) => rule.name === name);
  if (matches.length > 1) throw new Error("ambiguous ruleset name");
  return matches[0];
}

export function pagesPolicyChanges(policies, branch) {
  return {
    create: !policies.some(
      (policy) => policy.type === "branch" && policy.name === branch,
    ),
    remove: policies.filter(
      (policy) => policy.type !== "branch" || policy.name !== branch,
    ),
  };
}
