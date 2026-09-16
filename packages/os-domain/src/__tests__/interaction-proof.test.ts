import { describe, expect, it } from "vitest";
import { DomainError } from "../errors.js";
import {
  FabricatedProofRefused,
  type ServerEstablishedApproval,
  assertOnlyDigestEcho,
  sealApprovalProof,
} from "../interaction-proof.js";
import type { JsonValue } from "../json.js";

/**
 * Swarm D — T-20, finding F08 (ADR 0086 §7).
 *
 * F08: the domain must offer no way to turn a client-supplied value into
 * recorded authority. There are two halves. `sealApprovalProof` is the only
 * constructor of an `ApprovalProof`, and it copies only server-established
 * facts, so a proof cannot be assembled from a request body at all.
 * `assertOnlyDigestEcho` runs on the request body first and refuses any field
 * that names a mechanism, an assurance, a timestamp or a proof — by name — so
 * a caller cannot even *offer* the fields the earlier route was tricked into
 * trusting. The wire schema (Swarm S, F02) strips them; this refuses them, and
 * the two together mean an overstated audit row has nowhere to enter.
 */

function facts(
  overrides: Partial<ServerEstablishedApproval> = {},
): ServerEstablishedApproval {
  return {
    mechanism: "webauthn",
    boundDigest: `sha256:${"a".repeat(64)}`,
    assurance: "phishing_resistant",
    verifiedAt: new Date("2026-08-31T12:00:00.000Z"),
    ...overrides,
  };
}

describe("sealApprovalProof copies only server-established facts", () => {
  it("builds a proof from the verified facts", () => {
    const proof = sealApprovalProof(facts({ credentialRef: "cred_1" }));
    expect(proof).toEqual({
      mechanism: "webauthn",
      boundDigest: `sha256:${"a".repeat(64)}`,
      assurance: "phishing_resistant",
      verifiedAt: new Date("2026-08-31T12:00:00.000Z"),
      credentialRef: "cred_1",
    });
  });

  it("omits credentialRef rather than storing undefined", () => {
    const proof = sealApprovalProof(facts());
    expect("credentialRef" in proof).toBe(false);
  });
});

describe("assertOnlyDigestEcho refuses a fabricated proof", () => {
  it("accepts the digest echo alone", () => {
    const body: JsonValue = { requestDigest: `sha256:${"b".repeat(64)}` };
    expect(() => assertOnlyDigestEcho(body)).not.toThrow();
  });

  it("accepts a digest echo plus an activation handle", () => {
    // `activationId` names a server-verified activation; it is not a proof and
    // not a claim, so it is the one companion field a body may carry.
    const body: JsonValue = {
      requestDigest: `sha256:${"b".repeat(64)}`,
      activationId: "act_123456",
    };
    expect(() => assertOnlyDigestEcho(body)).not.toThrow();
  });

  const fabrications: ReadonlyArray<[string, string]> = [
    ["mechanism", "webauthn"],
    ["assurance", "phishing_resistant"],
    ["verifiedAt", new Date().toISOString()],
    ["credentialRef", "cred_attacker"],
    ["boundDigest", `sha256:${"c".repeat(64)}`],
  ];
  for (const [key, value] of fabrications) {
    it(`refuses a body naming ${key} and says which field`, () => {
      const body: JsonValue = {
        requestDigest: `sha256:${"b".repeat(64)}`,
        [key]: value,
      };
      try {
        assertOnlyDigestEcho(body);
        expect.unreachable("should have refused");
      } catch (error) {
        expect(error).toBeInstanceOf(FabricatedProofRefused);
        expect(String(error)).toContain(key);
      }
    });
  }

  it("refuses a nested proof object", () => {
    const body: JsonValue = {
      requestDigest: `sha256:${"b".repeat(64)}`,
      proof: { mechanism: "webauthn", assurance: "phishing_resistant" },
    };
    expect(() => assertOnlyDigestEcho(body)).toThrow(FabricatedProofRefused);
  });

  it("refuses an unexpected field even when it looks harmless", () => {
    const body: JsonValue = {
      requestDigest: `sha256:${"b".repeat(64)}`,
      note: "please trust me",
    };
    expect(() => assertOnlyDigestEcho(body)).toThrow(DomainError);
  });

  it("refuses a missing or non-string digest", () => {
    expect(() => assertOnlyDigestEcho({})).toThrow(DomainError);
    expect(() => assertOnlyDigestEcho({ requestDigest: 12 })).toThrow(
      DomainError,
    );
    expect(() => assertOnlyDigestEcho("nope")).toThrow(DomainError);
    expect(() => assertOnlyDigestEcho(null)).toThrow(DomainError);
    expect(() => assertOnlyDigestEcho([])).toThrow(DomainError);
  });
});
