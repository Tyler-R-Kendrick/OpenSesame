import { fixtures } from "@opensesame/os-domain";
import { assertAtMostWins } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_POST_CLAIM_SCOPES,
  DEFAULT_PRE_CLAIM_SCOPES,
  evaluateAgentAuthScopes,
  intersectAgentAuthScopes,
} from "../agent-auth-scopes.js";
import { ProvisionalPolicy } from "../provisional.js";

describe("PACT — agent-auth scopes", () => {
  it("property: intersection is never a union", () => {
    const left = intersectAgentAuthScopes({
      requested: ["resource:read", "claim:create"],
      registration: ["resource:read"],
    });
    const right = intersectAgentAuthScopes({
      requested: ["resource:read"],
      registration: ["resource:read", "claim:create"],
    });
    expect(left).toEqual(["resource:read"]);
    expect(right).toEqual(["resource:read"]);
    expect(new Set([...left, ...right]).size).toBe(1);
  });

  it("adversarial: an unknown protocol name cannot buy a domain action", () => {
    const policy = new ProvisionalPolicy();
    const result = evaluateAgentAuthScopes(
      policy,
      fixtures.verifiedPrincipal(),
      ["principal.merge", "grant.export_raw_credential"],
    );
    expect(result.allowed).toEqual([]);
    expect(result.denied).toEqual([
      "principal.merge",
      "grant.export_raw_credential",
    ]);
  });

  it("contract: post-claim is a strict superset of pre-claim", () => {
    for (const scope of DEFAULT_PRE_CLAIM_SCOPES) {
      expect(DEFAULT_POST_CLAIM_SCOPES).toContain(scope);
    }
    expect(DEFAULT_POST_CLAIM_SCOPES.length).toBeGreaterThan(
      DEFAULT_PRE_CLAIM_SCOPES.length,
    );
  });

  it("chaos: concurrent evaluators at the unknown-scope input fail closed", async () => {
    const policy = new ProvisionalPolicy();
    await assertAtMostWins(async () => {
      return (
        evaluateAgentAuthScopes(policy, fixtures.provisionalPrincipal(), [
          "admin.impersonate",
        ]).allowed.length > 0
      );
    }, 0);
  });
});
