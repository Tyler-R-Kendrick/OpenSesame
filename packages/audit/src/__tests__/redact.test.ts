import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  AUDIT_METADATA_ALLOWLIST,
  AUDIT_VALUE_MAX_LENGTH,
  isDeniedAuditMetadataKey,
  redactAuditMetadata,
} from "../redact.js";

describe("redactAuditMetadata", () => {
  it("keeps allowlisted keys and drops secrets", () => {
    const out = redactAuditMetadata({
      action: "claim.complete",
      claimToken: "osc_clm_x.y",
      userCode: "AAAA-BBBB",
      password: "nope",
      unknownField: "drop-me",
      state: "completed",
    });
    expect(out).toEqual({
      action: "claim.complete",
      state: "completed",
    });
  });

  it("keeps the fields that say which identity was linked", () => {
    // The link event carries the assurance upgrade, so an audit trail that drops
    // the issuer and kind on the way in is missing exactly what a reviewer reads.
    expect(
      redactAuditMetadata({
        action: "principal.link_identity",
        kind: "oidc",
        issuer: "https://idp.example",
        tenant: "acme",
        note: "email_not_used_for_link",
      }),
    ).toEqual({
      action: "principal.link_identity",
      kind: "oidc",
      issuer: "https://idp.example",
      tenant: "acme",
      note: "email_not_used_for_link",
    });
  });

  it("bounds a caller-supplied value", () => {
    const long = "https://idp.example/".padEnd(5_000, "x");
    const out = overlapCast<unknown, { issuer: string }>(
      redactAuditMetadata({ issuer: long }),
    );
    // Truncated, not dropped: a shortened issuer still says what happened, and
    // the store no longer grows to whatever length a caller sends.
    expect(out.issuer.length).toBe(AUDIT_VALUE_MAX_LENGTH + 1);
    expect(out.issuer.startsWith("https://idp.example/")).toBe(true);
    expect(out.issuer.endsWith("…")).toBe(true);
  });

  it("keeps changelog key names and rejects secret-bearing keys", () => {
    expect(
      redactAuditMetadata({
        configId: "cfg",
        environment: "development",
        keyNames: ["FOO", "BAR"],
        versionId: "v1",
        value: "plaintext",
        secret: "s",
        password: "p",
        token: "t",
      }),
    ).toEqual({
      configId: "cfg",
      environment: "development",
      keyNames: ["FOO", "BAR"],
      versionId: "v1",
    });
  });
});

describe("authorization inbox metadata (ADR 0046)", () => {
  it("keeps the ids and digests an approval review needs", () => {
    const kept = redactAuditMetadata({
      authReqId: "areq_abc",
      approvalId: "approval_abc",
      requestDigest: "a".repeat(64),
      bindingMessageDigest: "b".repeat(64),
      decidedByKind: "human",
      connectionId: "connection_1",
      delegationId: "dlg_1",
    });
    expect(kept).toEqual({
      authReqId: "areq_abc",
      approvalId: "approval_abc",
      requestDigest: "a".repeat(64),
      bindingMessageDigest: "b".repeat(64),
      decidedByKind: "human",
      connectionId: "connection_1",
      delegationId: "dlg_1",
    });
  });

  it("drops inbox keys named for the secret they identify", () => {
    // The deny pass runs before the allowlist, so these never survive however
    // they are listed. Naming a field `userCode` rather than a digest is how a
    // reviewer ends up with a blank event, and this is the guard against it.
    const dropped = redactAuditMetadata({
      userCode: "ABCD-EFGH",
      bindingToken: "osc_dlg_secret",
      approvalSecret: "s",
      deviceCode: "d",
    });
    expect(dropped).toEqual({});
  });
});

describe("redaction boundaries (mutation coverage)", () => {
  it("pins the exact allowlist", () => {
    // A characterization of the boundary itself: any membership change — a key
    // added, removed, or blanked — must be a reviewed edit to this list too.
    expect([...AUDIT_METADATA_ALLOWLIST]).toEqual([
      "reason",
      "action",
      "kind",
      "issuer",
      "tenant",
      "slug",
      "note",
      "sectorIdentifier",
      "admissionMode",
      "previousClientId",
      "resourceType",
      "resourceId",
      "projectId",
      "organizationId",
      "claimId",
      "agentId",
      "state",
      "fromState",
      "toState",
      "outcome",
      "idempotencyKey",
      "ttlSeconds",
      "quotaProfile",
      "path",
      "method",
      "statusCode",
      "won",
      "count",
      "type",
      "configId",
      "environment",
      "keyNames",
      "versionId",
      "targetId",
      "contentVersion",
      "actor",
      "authReqId",
      "approvalId",
      "requestDigest",
      "bindingMessageDigest",
      "decidedByKind",
      "connectionId",
      "delegationId",
      "offerId",
      "invocationId",
      "subject",
      "providerId",
      "materialization",
    ]);
  });

  it("denies code-shaped keys with or without a separator", () => {
    for (const key of [
      "usercode",
      "user_code",
      "userCode",
      "devicecode",
      "device_code",
      "deviceCode",
      "bearerHint",
      "refreshHandle",
    ]) {
      expect(isDeniedAuditMetadataKey(key), key).toBe(true);
    }
    expect(isDeniedAuditMetadataKey("reason")).toBe(false);
  });

  it("drops a secret-shaped key even when the allowlist names it", () => {
    AUDIT_METADATA_ALLOWLIST.add("bearerHint");
    try {
      expect(redactAuditMetadata({ bearerHint: "x" })).toEqual({});
    } finally {
      AUDIT_METADATA_ALLOWLIST.delete("bearerHint");
    }
  });

  it("keeps a value exactly at the length cap and truncates one past it", () => {
    const exact = "a".repeat(AUDIT_VALUE_MAX_LENGTH);
    expect(redactAuditMetadata({ note: exact })).toEqual({ note: exact });
    const over = "a".repeat(AUDIT_VALUE_MAX_LENGTH + 1);
    expect(redactAuditMetadata({ note: over })).toEqual({ note: `${exact}…` });
  });

  it("keeps null and drops structured values it cannot vouch for", () => {
    expect(redactAuditMetadata({ won: null })).toEqual({ won: null });
    expect(redactAuditMetadata({ note: { nested: 1 } })).toEqual({});
    expect(redactAuditMetadata({ keyNames: [1, 2] })).toEqual({});
    expect(redactAuditMetadata({ keyNames: ["ok", 1] })).toEqual({});
  });

  it("bounds every entry of a string-array value", () => {
    const over = "k".repeat(AUDIT_VALUE_MAX_LENGTH + 1);
    expect(redactAuditMetadata({ keyNames: [over, "SHORT"] })).toEqual({
      keyNames: [`${"k".repeat(AUDIT_VALUE_MAX_LENGTH)}…`, "SHORT"],
    });
  });
});
