import { describe, expect, it } from "vitest";
import {
  parseAgentClaimAttemptToken,
  parseAgentClaimToken,
} from "../crypto/agent-auth-tokens.js";
import { parseClaimToken } from "../crypto/claim-token.js";
import {
  canTransitionAgentRegistration,
  claimAgentRegistration,
  isTerminalAgentRegistration,
  markAgentRegistrationClaimPending,
  revokeAgentRegistration,
} from "../machines/agent-registration.js";
import type { AgentRegistration, AgentRegistrationStatus } from "../types.js";

const now = new Date("2026-09-02T12:00:00.000Z");
const ALL: AgentRegistrationStatus[] = [
  "unclaimed",
  "claim_pending",
  "claimed",
  "expired",
  "revoked",
];

function registration(
  overrides: Partial<AgentRegistration> = {},
): AgentRegistration {
  return {
    id: "areg_pact",
    kind: "anonymous",
    status: "unclaimed",
    principalId: "prn_p",
    createdAt: now,
    expiresAt: new Date(now.getTime() + 86_400_000),
    preClaimScopes: ["resource:read"],
    postClaimScopes: ["resource:read"],
    assertionVersion: 1,
    version: 1,
    ...overrides,
  };
}

describe("PACT — agent registration", () => {
  it("property: terminal statuses never leave the terminal set", () => {
    expect(isTerminalAgentRegistration("claimed")).toBe(false);
    expect(canTransitionAgentRegistration("claimed", "revoked")).toBe(true);
    for (const from of ALL.filter(isTerminalAgentRegistration)) {
      for (const to of ALL) {
        expect(canTransitionAgentRegistration(from, to), `${from}->${to}`).toBe(
          false,
        );
      }
    }
  });

  it("contract: the allowed transition table is exact", () => {
    const allowed: Array<[AgentRegistrationStatus, AgentRegistrationStatus]> = [
      ["unclaimed", "claim_pending"],
      ["unclaimed", "expired"],
      ["unclaimed", "revoked"],
      ["claim_pending", "claimed"],
      ["claim_pending", "claim_pending"],
      ["claim_pending", "expired"],
      ["claim_pending", "revoked"],
      ["claimed", "revoked"],
    ];
    for (const from of ALL) {
      for (const to of ALL) {
        const ok = allowed.some(([a, b]) => a === from && b === to);
        expect(canTransitionAgentRegistration(from, to), `${from}->${to}`).toBe(
          ok,
        );
      }
    }
  });

  it("adversarial: product claim tokens never parse as agent claim tokens", () => {
    for (const bad of [
      "",
      "osc_clm_id.secret",
      "pst_abc",
      "aat_id.secret",
      "clm_",
      "clm_onlyid",
      "clm_.secret",
      "clm_id.",
    ]) {
      expect(parseAgentClaimToken(bad), bad).toBeNull();
    }
    expect(parseClaimToken("clm_id.secret")).toBeNull();
    expect(parseAgentClaimAttemptToken("clm_id.secret")).toBeNull();
  });

  it("contract: claiming retargets the registration and never mutates the input", () => {
    const pending = markAgentRegistrationClaimPending(
      registration({ principalId: "prn_provisional" }),
      now,
    );
    const original = { ...pending };
    const claimed = claimAgentRegistration(pending, "prn_existing", now);
    expect(pending.status).toBe(original.status);
    expect(claimed.principalId).toBe("prn_existing");
    expect(claimed.claimedByPrincipalId).toBe("prn_existing");
    expect(claimed.id).toBe("areg_pact");
  });

  it("chaos: concurrent revoke of one registration does not mutate the original", async () => {
    const live = registration();
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, async () => {
        revokeAgentRegistration(live, now);
        return live.status === "revoked";
      }),
    );
    expect(outcomes.every((won) => !won)).toBe(true);
    expect(live.status).toBe("unclaimed");
  });
});
