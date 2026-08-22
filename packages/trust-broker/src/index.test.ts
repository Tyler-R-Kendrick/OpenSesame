import type { IdentityEvidence } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { evaluateAssurance } from "./index.js";
const evidence = (
  overrides: Partial<IdentityEvidence> = {},
): IdentityEvidence => ({
  id: "e",
  principalId: "p",
  source: "oidc_id_token",
  issuer: "https://issuer",
  sourceArtifactDigest: "d",
  claims: [],
  assurance: {
    subjectKind: "human",
    identityProofing: "verified_account",
    federationIssuerTrust: "allowlisted",
    authentication: {
      methods: ["pwd"],
      userVerification: "none",
      deviceBinding: "software",
      keyProtection: "software_non_exportable",
      syncability: "single_device",
    },
  },
  acquiredAt: new Date("2026-01-01"),
  verifiedAt: new Date("2026-01-01"),
  state: "active",
  trustPolicyId: "t",
  version: 1,
  metadata: {},
  ...overrides,
});
describe("assurance evaluator", () => {
  it("does not treat MFA as phishing resistance", () =>
    expect(
      evaluateAssurance({
        evidence: [evidence()],
        authentication: {
          methods: ["pwd", "otp"],
          factorCount: 2,
          userVerification: "none",
          deviceBinding: "software",
          keyProtection: "software_non_exportable",
          syncability: "single_device",
        },
        requirement: { subjectKind: "human", requirePhishingResistance: true },
        now: new Date("2026-01-02"),
      }).allowed,
    ).toBe(false));
  it("rejects stale evidence", () =>
    expect(
      evaluateAssurance({
        evidence: [evidence()],
        requirement: { subjectKind: "human", maximumEvidenceAgeSeconds: 60 },
        now: new Date("2026-01-02"),
      }).missing,
    ).toContain("identity_evidence"));
  it("never lets workload evidence satisfy a human request", () =>
    expect(
      evaluateAssurance({
        evidence: [
          evidence({
            assurance: { ...evidence().assurance, subjectKind: "workload" },
          }),
        ],
        requirement: { subjectKind: "human" },
        now: new Date("2026-01-02"),
      }).allowed,
    ).toBe(false));

  it("contract: selects evidence that actually satisfies the requested fact", () => {
    const stale = evidence({
      id: "stale",
      verifiedAt: new Date("2025-12-31T23:59:00Z"),
    });
    const fresh = evidence({
      id: "fresh",
      verifiedAt: new Date("2026-01-01T00:00:30Z"),
    });
    const decision = evaluateAssurance({
      evidence: [stale, fresh],
      requirement: {
        subjectKind: "human",
        minimumIdentityProofing: ["verified_account"],
        maximumEvidenceAgeSeconds: 60,
      },
      now: new Date("2026-01-01T00:01:00Z"),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.evidence).toEqual(["fresh"]);
  });

  it("chaos: removing facts cannot turn a denial into an allow", () => {
    const full = evaluateAssurance({
      evidence: [evidence()],
      authentication: {
        methods: ["webauthn"],
        userVerification: "local_user_verification",
        phishingResistant: true,
        verifierNameBound: true,
        deviceBinding: "hardware",
        keyProtection: "strongbox_backed",
        syncability: "single_device",
      },
      requirement: {
        subjectKind: "human",
        requireUserVerification: true,
        requirePhishingResistance: true,
        requireVerifierNameBinding: true,
        minimumDeviceBinding: ["hardware"],
        minimumKeyProtection: ["strongbox_backed"],
      },
      now: new Date("2026-01-01T00:00:30Z"),
    });
    const reducedInput = fullInput(full);
    const reduced = evaluateAssurance({
      ...reducedInput,
      authentication: {
        ...reducedInput.authentication,
        phishingResistant: false,
      },
    });
    expect(full.allowed).toBe(true);
    expect(reduced.allowed).toBe(false);
  });

  it("characterization: emits stable audit-safe reason codes", () => {
    expect(
      evaluateAssurance({
        evidence: [],
        requirement: { subjectKind: "human", requireUserVerification: true },
        now: new Date("2026-01-01"),
      }),
    ).toMatchInlineSnapshot(`
      {
        "allowed": false,
        "evidence": [],
        "legacyProjection": "provisional",
        "missing": [
          "identity_evidence",
          "user_verification",
        ],
        "reasonCodes": [
          "insufficient_user_authentication",
          "identity_evidence",
          "user_verification",
        ],
        "satisfied": [],
      }
    `);
  });
});

function fullInput(decision: ReturnType<typeof evaluateAssurance>) {
  return {
    evidence: [evidence()],
    authentication: {
      methods: ["webauthn"],
      userVerification: "local_user_verification" as const,
      phishingResistant: decision.allowed,
      verifierNameBound: true,
      deviceBinding: "hardware" as const,
      keyProtection: "strongbox_backed" as const,
      syncability: "single_device" as const,
    },
    requirement: {
      subjectKind: "human" as const,
      requireUserVerification: true,
      requirePhishingResistance: true,
      requireVerifierNameBinding: true,
      minimumDeviceBinding: ["hardware" as const],
      minimumKeyProtection: ["strongbox_backed" as const],
    },
    now: new Date("2026-01-01T00:00:30Z"),
  };
}
