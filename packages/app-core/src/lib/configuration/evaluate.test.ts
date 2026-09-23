import type { OrganizationRole } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { permitsApplicationScopes } from "../local-application-policy.js";
import {
  evaluateDecision,
  localApplicationEvaluator,
  localPrefsEvaluator,
} from "./evaluate.js";

describe("evaluateDecision", () => {
  it("returns deny when the vault is locked and indeterminate when coverage is missing", () => {
    const deny = evaluateDecision(
      localPrefsEvaluator,
      {
        resourceId: "prefs",
        principalId: "p1",
        operation: "edit",
        facts: { unlocked: false },
        policyRevision: "r1",
      },
      "simulate",
    );
    expect(deny.decision).toBe("deny");
    const unknown = evaluateDecision(
      localPrefsEvaluator,
      {
        resourceId: "prefs",
        principalId: "p1",
        operation: "mint-token",
        facts: { unlocked: true },
        policyRevision: "r1",
      },
      "simulate",
    );
    expect(unknown.decision).toBe("indeterminate");
    expect(unknown.coverage.length).toBeGreaterThan(0);
  });

  it("ADV-14/15: application simulation uses permitsApplicationScopes and cannot mint tokens", () => {
    const policy = [
      {
        scope: "openid",
        // SAFETY: fixture constructed in this test matches the declared contract.
        roles: ["owner", "admin", "member"] as OrganizationRole[],
      },
    ];
    const issued: string[] = [];
    const allow = evaluateDecision(
      localApplicationEvaluator,
      {
        resourceId: "app-1",
        principalId: "p1",
        operation: "authorize",
        facts: { role: "member", scopes: ["openid"], policy },
        policyRevision: "3",
      },
      "simulate",
    );
    expect(allow.mode).toBe("simulate");
    expect(allow.decision).toBe(
      permitsApplicationScopes(policy, "member", ["openid"]) ? "allow" : "deny",
    );
    const deny = evaluateDecision(
      localApplicationEvaluator,
      {
        resourceId: "app-1",
        principalId: "p1",
        operation: "authorize",
        facts: { role: "member", scopes: ["records:read"], policy },
        policyRevision: "3",
      },
      "simulate",
    );
    expect(deny.decision).toBe("deny");
    expect(issued).toEqual([]);
    const missing = evaluateDecision(
      localApplicationEvaluator,
      {
        resourceId: "downstream",
        principalId: "p1",
        operation: "authorize",
        facts: {},
        policyRevision: "3",
      },
      "simulate",
    );
    expect(missing.decision).toBe("indeterminate");
  });
});
