import { describe, expect, it } from "vitest";
import { redactAuditMetadata } from "../redact.js";

/**
 * Characterization snapshots for audit redaction.
 *
 * These do not assert that the current behavior is *right* — the unit tests
 * beside them do that. They pin what actually reaches the trail, so a change
 * to the allowlist or the deny pattern has to be looked at and accepted rather
 * than discovered later by a reviewer staring at a blank event.
 *
 * If one of these fails, read the diff before updating it: a key that stops
 * appearing is an event losing evidence, and a key that starts appearing may
 * be a secret finding its way into an append-only log.
 */
describe("redaction characterization", () => {
  it("keeps exactly this much of a realistic authorization-inbox event", () => {
    expect(
      redactAuditMetadata({
        authReqId: "areq_1",
        approvalId: "approval_1",
        requestDigest: "a".repeat(64),
        bindingMessageDigest: "b".repeat(64),
        decidedByKind: "agent",
        connectionId: "connection_1",
        delegationId: "dlg_1",
        offerId: "dlgo_1",
        invocationId: "inv_1",
        // Everything below must be dropped.
        userCode: "ABCD-EFGH",
        claimToken: "osc_clm_secret",
        accessToken: "at_secret",
        refreshToken: "rt_secret",
        clientSecret: "cs_secret",
        codeVerifier: "cv_secret",
        password: "hunter2",
        authorization: "Bearer x",
        cookie: "sid=1",
        somethingUnlisted: "dropped because it is not allowlisted",
      }),
    ).toMatchSnapshot();
  });

  it("keeps exactly this much of a realistic claim/connection event", () => {
    expect(
      redactAuditMetadata({
        action: "claim.completed",
        claimId: "clm_1",
        agentId: "agt_1",
        projectId: "prj_1",
        organizationId: "org_1",
        state: "completed",
        fromState: "reviewed",
        toState: "completed",
        outcome: "succeeded",
        won: true,
        count: 3,
        quotaProfile: "anonymous",
        idempotencyKey: "idem-1",
        shareability: "not-allowlisted-yet",
        deviceCode: "dc_secret",
        tokenDigest: "also dropped: the key says token",
      }),
    ).toMatchSnapshot();
  });

  it("truncates long values rather than letting the trail grow unbounded", () => {
    expect(
      redactAuditMetadata({
        issuer: `https://issuer.example/${"x".repeat(400)}`,
      }),
    ).toMatchSnapshot();
  });
});
