import {
  type LocalScopeRoles,
  permitsApplicationScopes,
} from "../local-application-policy.js";

export type EvaluationDecision = "allow" | "deny" | "indeterminate";

export type EvaluationInput = {
  resourceId: string;
  principalId: string;
  operation: string;
  facts: Record<string, unknown>;
  policyRevision: string;
};

export type EvaluationResult = {
  decision: EvaluationDecision;
  policyRevision: string;
  mode: "simulate" | "enforce";
  rules: readonly string[];
  missingFacts: readonly string[];
  coverage: string;
};

export type Evaluator = (
  input: EvaluationInput,
  mode: "simulate" | "enforce",
) => EvaluationResult;

/**
 * Run the same function used for enforcement. Simulation cannot mint tokens
 * or perform side effects; callers must pass a pure evaluator.
 */
export function evaluateDecision(
  evaluator: Evaluator,
  input: EvaluationInput,
  mode: "simulate" | "enforce" = "simulate",
): EvaluationResult {
  const result = evaluator(input, mode);
  if (mode === "simulate") {
    return { ...result, mode: "simulate" };
  }
  return result;
}

export function localPrefsEvaluator(
  input: EvaluationInput,
  mode: "simulate" | "enforce",
): EvaluationResult {
  if (input.operation !== "read" && input.operation !== "edit") {
    return {
      decision: "indeterminate",
      policyRevision: input.policyRevision,
      mode,
      rules: [],
      missingFacts: ["operation"],
      coverage: "This evaluator only covers local preference read/edit.",
    };
  }
  if (input.facts.unlocked !== true) {
    return {
      decision: "deny",
      policyRevision: input.policyRevision,
      mode,
      rules: ["vault.unlocked"],
      missingFacts: [],
      coverage: "Local vault prefs require an unlocked tomb.",
    };
  }
  return {
    decision: "allow",
    policyRevision: input.policyRevision,
    mode,
    rules: ["vault.unlocked"],
    missingFacts: [],
    coverage: "Local vault prefs.",
  };
}

/**
 * Same function as local application grant admission (`permitsApplicationScopes`).
 * Simulation cannot mint tokens or complete consent.
 */
export function localApplicationEvaluator(
  input: EvaluationInput,
  mode: "simulate" | "enforce",
): EvaluationResult {
  const role = input.facts.role;
  const scopes = input.facts.scopes;
  const policy = input.facts.policy;
  if (
    (role !== "owner" && role !== "admin" && role !== "member") ||
    !Array.isArray(scopes) ||
    !Array.isArray(policy)
  ) {
    return {
      decision: "indeterminate",
      policyRevision: input.policyRevision,
      mode,
      rules: [],
      missingFacts: ["role", "scopes", "policy"],
      coverage:
        "Local application evaluation needs role, requested scopes, and scope-role policy.",
    };
  }
  const permitted = permitsApplicationScopes(
    policy as LocalScopeRoles[],
    role,
    scopes as string[],
  );
  return {
    decision: permitted ? "allow" : "deny",
    policyRevision: input.policyRevision,
    mode,
    rules: ["local.scopeRoles"],
    missingFacts: [],
    coverage:
      "Local application scope-role policy. Downstream apps are not evaluated.",
  };
}
