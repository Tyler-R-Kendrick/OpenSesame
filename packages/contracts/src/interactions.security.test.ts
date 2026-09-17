import { describe, expect, it } from "vitest";
import {
  ApproveInteractionSchema,
  DenyInteractionSchema,
} from "./interactions.js";

/**
 * Swarm S — contract-level guard for finding F02 (ADR 0086).
 *
 * F02: the mobile-mfa / ceremony-kit clients historically transmitted a
 * client-constructed `ApprovalProof` (mechanism, assurance, credential
 * handle) to the interaction approve route, and the server stripped it. The
 * required end state is that the *accepted request shape* carries no client
 * proof at all — approving echoes the digest and nothing else — so that
 * nothing a caller writes can be laundered into recorded evidence. Evidence is
 * whatever the authority itself verifies (a transaction-bound assertion), not
 * a field the client filled in.
 *
 * This test pins that invariant at the schema boundary: it must hold now and
 * must not regress when the raw proof-response contract lands.
 */
describe("ApproveInteractionSchema carries no client-supplied proof (F02)", () => {
  it("accepts only the digest echo", () => {
    const digest = `v2:${"a".repeat(64)}`;
    const parsed = ApproveInteractionSchema.parse({ requestDigest: digest });
    expect(parsed).toEqual({ requestDigest: digest });
    // The accepted shape has exactly one key. A second field would be a place
    // a client could smuggle a claim the server is tempted to trust.
    expect(Object.keys(parsed)).toEqual(["requestDigest"]);
  });

  it("never surfaces a client-constructed ApprovalProof", () => {
    const digest = `v2:${"b".repeat(64)}`;
    expect(
      ApproveInteractionSchema.safeParse({
        requestDigest: digest,
        proof: {
          mechanism: "webauthn",
          boundDigest: digest,
          credentialRef: "cred_attacker",
          assurance: "phishing_resistant",
        },
        mechanism: "webauthn",
        assurance: "phishing_resistant",
        credentialRef: "cred_attacker",
        verifiedAt: new Date().toISOString(),
      }).success,
    ).toBe(false);
  });

  it("denial is the digest echo too, with no proof surface", () => {
    const digest = `v2:${"c".repeat(64)}`;
    expect(
      DenyInteractionSchema.safeParse({
        requestDigest: digest,
        proof: {
          mechanism: "webauthn",
          boundDigest: digest,
          assurance: "high",
        },
      }).success,
    ).toBe(false);
  });

  it("still refuses a missing or too-short digest", () => {
    expect(ApproveInteractionSchema.safeParse({}).success).toBe(false);
    expect(
      ApproveInteractionSchema.safeParse({ requestDigest: "short" }).success,
    ).toBe(false);
  });
});
