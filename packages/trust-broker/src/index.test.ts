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
});
