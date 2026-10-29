import { isDeepStrictEqual } from "node:util";

/**
 * Rules GitHub is known to answer with parameters nobody sent: an `update`
 * rule comes back with `update_allows_fetch_and_merge`. For these, parameters
 * the policy leaves out are not compared, so a ruleset GitHub echoed defaults
 * on is not drift. Every other rule is compared exactly.
 */
const SERVER_DEFAULTED = new Set(["update"]);

function rulesView(rules, policy) {
  return rules.map((rule) => {
    const sent = policy.rules.find((one) => one.type === rule.type);
    if (!SERVER_DEFAULTED.has(rule.type) || !sent || "parameters" in sent) {
      return rule;
    }
    return Object.fromEntries(
      Object.entries(rule).filter(([key]) => key !== "parameters"),
    );
  });
}

/**
 * Ignore server-owned metadata, never policy fields. `spec` is the policy the
 * view is compared with: the rules GitHub defaults are read against it.
 */
export function policyView(policy, spec = policy) {
  return {
    ...Object.fromEntries(
      ["name", "target", "enforcement", "bypass_actors", "conditions"].map(
        (key) => [key, policy[key]],
      ),
    ),
    rules: rulesView(policy.rules, spec),
  };
}

export function rulesetAction(current, expected) {
  if (!current) return "create";
  if (current.name !== expected.name)
    throw new Error("ruleset ownership mismatch");
  return isDeepStrictEqual(
    policyView(current, expected),
    policyView(expected, expected),
  )
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

/** Install a separate creation exception without granting tag mutation bypass. */
export function applyReleaseTagPolicies(
  write,
  currentTags,
  currentCreation,
  tags,
  creation,
) {
  let guarded = currentTags;
  if (!guarded) {
    // Bootstrap owner-only creation/update/deletion before granting any app
    // exception. A partial first activation must never expose mutable tags.
    const bootstrap = { ...tags, rules: [{ type: "creation" }, ...tags.rules] };
    guarded = write(bootstrap, null, "create");
    if (!guarded?.id)
      throw new Error("Release tag bootstrap returned no ruleset identity");
  }
  // Existing combined owner-only protection remains until creation policy is
  // present. If its write fails, do not remove the legacy creation restriction.
  write(creation, currentCreation, rulesetAction(currentCreation, creation));
  write(tags, guarded, rulesetAction(guarded, tags));
}
