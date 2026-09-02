import { describe, expect, it } from "vitest";
import {
  AGENT_ACCESS_TOKEN_PREFIX,
  AGENT_CLAIM_ATTEMPT_PREFIX,
  AGENT_CLAIM_TOKEN_PREFIX,
  digestAgentClaimToken,
  digestAgentUserCode,
  generateAgentAccessToken,
  generateAgentAccessTokenId,
  generateAgentClaimAttemptId,
  generateAgentClaimAttemptToken,
  generateAgentClaimToken,
  generateAgentRegistrationId,
  generateAgentUserCode,
  looksLikeAgentAccessToken,
  looksLikeAgentClaimToken,
  parseAgentClaimAttemptToken,
  parseAgentClaimToken,
  verifyAgentAccessToken,
  verifyAgentClaimAttemptToken,
  verifyAgentClaimToken,
  verifyAgentUserCode,
} from "../crypto/agent-auth-tokens.js";
import { generateClaimToken } from "../crypto/claim-token.js";
import { DomainError } from "../errors.js";
import {
  claimAgentRegistration,
  claimedPrincipalId,
  markAgentRegistrationClaimPending,
  markAgentRegistrationExpired,
  revokeAgentRegistration,
} from "../machines/agent-registration.js";
import type { AgentRegistration } from "../types.js";

const now = new Date("2026-09-02T12:00:00.000Z");

function registration(
  overrides: Partial<AgentRegistration> = {},
): AgentRegistration {
  return {
    id: "areg_test",
    kind: "anonymous",
    status: "unclaimed",
    principalId: "prn_test_provisional_001",
    createdAt: now,
    expiresAt: new Date(now.getTime() + 86_400_000),
    preClaimScopes: ["resource:read"],
    postClaimScopes: ["resource:read", "resource:create:temporary"],
    assertionVersion: 1,
    version: 1,
    ...overrides,
  };
}

describe("agent registration state machine", () => {
  it("moves unclaimed → claim_pending → claimed without changing kind", () => {
    const pending = markAgentRegistrationClaimPending(registration(), now);
    expect(pending.status).toBe("claim_pending");
    expect(pending.kind).toBe("anonymous");
    const claimed = claimAgentRegistration(pending, "prn_verified", now);
    expect(claimed.status).toBe("claimed");
    expect(claimed.principalId).toBe("prn_verified");
    expect(claimed.claimedByPrincipalId).toBe("prn_verified");
    expect(claimed.assertionVersion).toBe(2);
    expect(claimed.id).toBe("areg_test");
  });

  it("refuses to claim a revoked registration", () => {
    const revoked = revokeAgentRegistration(registration(), now);
    expect(() => claimAgentRegistration(revoked, "prn_verified", now)).toThrow(
      DomainError,
    );
  });

  it("refuses to expire before TTL", () => {
    expect(() => markAgentRegistrationExpired(registration(), now)).toThrow(
      DomainError,
    );
  });

  it("expires after TTL from a live state", () => {
    const expired = markAgentRegistrationExpired(
      registration(),
      new Date(now.getTime() + 86_400_001),
    );
    expect(expired.status).toBe("expired");
  });

  it("lets a claimed registration be revoked after TTL", () => {
    const claimed = claimAgentRegistration(
      markAgentRegistrationClaimPending(registration(), now),
      "prn_verified",
      now,
    );
    const later = new Date(now.getTime() + 86_400_001);
    const revoked = revokeAgentRegistration(claimed, later);
    expect(revoked.status).toBe("revoked");
    expect(revoked.principalId).toBe("prn_verified");
  });

  it("does not merge principals: claim retargets the registration only", () => {
    const pending = markAgentRegistrationClaimPending(
      registration({ principalId: "prn_provisional" }),
      now,
    );
    const claimed = claimAgentRegistration(pending, "prn_existing", now);
    expect(claimed.principalId).toBe("prn_existing");
    expect(claimed.claimedByPrincipalId).toBe("prn_existing");
    expect(claimedPrincipalId(claimed)).toBe("prn_existing");
    expect(claimedPrincipalId(registration())).toBe("prn_test_provisional_001");
  });
});

describe("agent-auth token domain separation", () => {
  const pepper = "test-pepper";

  it("uses clm_ not osc_clm_ and does not verify as a product claim token", () => {
    const agent = generateAgentClaimToken(pepper);
    expect(agent.token.startsWith(AGENT_CLAIM_TOKEN_PREFIX)).toBe(true);
    expect(agent.token.startsWith("osc_clm_")).toBe(false);
    expect(looksLikeAgentClaimToken(agent.token)).toBe(true);
    expect(looksLikeAgentAccessToken(agent.token)).toBe(false);
  });

  it("rejects a product claim token as an agent claim token", () => {
    const product = generateClaimToken(pepper);
    expect(digestAgentClaimToken(pepper, product.token)).toBeNull();
    expect(looksLikeAgentClaimToken(product.token)).toBe(false);
  });

  it("verifies an agent claim token against its digest only", () => {
    const agent = generateAgentClaimToken(pepper);
    expect(verifyAgentClaimToken(pepper, agent.token, agent.digest)).toBe(true);
    const other = generateAgentClaimToken(pepper);
    expect(verifyAgentClaimToken(pepper, other.token, agent.digest)).toBe(
      false,
    );
  });

  it("binds user codes to the attempt id", () => {
    const code = generateAgentUserCode();
    expect(code).toMatch(/^\d{6}$/);
    const digest = digestAgentUserCode(pepper, "cla_one", code);
    expect(verifyAgentUserCode(pepper, "cla_one", code, digest)).toBe(true);
    expect(verifyAgentUserCode(pepper, "cla_two", code, digest)).toBe(false);
    expect(() => digestAgentUserCode(pepper, "", code)).toThrow(
      /claim attempt id/,
    );
  });

  it("keeps claim, attempt, and access prefixes disjoint", () => {
    const claim = generateAgentClaimToken(pepper);
    const attempt = generateAgentClaimAttemptToken(pepper);
    const access = generateAgentAccessToken(pepper);
    expect(claim.token.startsWith(AGENT_CLAIM_TOKEN_PREFIX)).toBe(true);
    expect(attempt.token.startsWith(AGENT_CLAIM_ATTEMPT_PREFIX)).toBe(true);
    expect(access.token.startsWith(AGENT_ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(parseAgentClaimToken(attempt.token)).toBeNull();
    expect(parseAgentClaimAttemptToken(claim.token)).toBeNull();
    expect(parseAgentClaimAttemptToken(access.token)).toBeNull();
    expect(looksLikeAgentAccessToken(access.token)).toBe(true);
    expect(looksLikeAgentAccessToken(claim.token)).toBe(false);
    expect(looksLikeAgentClaimToken(attempt.token)).toBe(false);
    expect(
      verifyAgentClaimAttemptToken(pepper, attempt.token, attempt.digest),
    ).toBe(true);
    expect(
      verifyAgentClaimAttemptToken(pepper, claim.token, attempt.digest),
    ).toBe(false);
    expect(verifyAgentAccessToken(pepper, access.token, access.digest)).toBe(
      true,
    );
    expect(verifyAgentAccessToken(pepper, claim.token, access.digest)).toBe(
      false,
    );
    expect(generateAgentRegistrationId().startsWith("areg_")).toBe(true);
    expect(generateAgentClaimAttemptId().startsWith("cla_")).toBe(true);
    expect(generateAgentAccessTokenId().startsWith("aatid_")).toBe(true);
  });
});
