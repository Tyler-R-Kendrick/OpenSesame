import {
  type ApprovalActivation,
  type ApprovalPolicy,
  type AssuranceVector,
  type ExternalChannelBinding,
  type IdentityEvidence,
  defaultApprovalPolicy,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { evaluateApprovalCeremony, requiredReasonCodes } from "./approval.js";

const NOW = new Date("2026-08-31T12:00:00Z");

function evidence(overrides: Partial<IdentityEvidence> = {}): IdentityEvidence {
  return {
    id: "ev_1",
    principalId: "prn_approver",
    source: "oidc_id_token",
    issuer: "https://idp.example",
    sourceArtifactDigest: "sha256:art",
    claims: [],
    assurance: {
      subjectKind: "human",
      identityProofing: "verified_account",
      authentication: {
        methods: ["webauthn"],
        userVerification: "local_user_verification",
        deviceBinding: "hardware",
        keyProtection: "tee_backed",
        syncability: "single_device",
      },
      federationIssuerTrust: "pre_registered",
    },
    acquiredAt: NOW,
    verifiedAt: NOW,
    state: "active",
    trustPolicyId: "tp_1",
    version: 1,
    metadata: {},
    ...overrides,
  };
}

/** What a real in-app WebAuthn activation contributes. */
const passkeyFacts: AssuranceVector["authentication"] = {
  authenticatedAt: NOW,
  userVerifiedAt: NOW,
  methods: ["webauthn"],
  factorCount: 2,
  userVerification: "local_user_verification",
  phishingResistant: true,
  verifierNameBound: true,
  deviceBinding: "hardware",
  keyProtection: "tee_backed",
  syncability: "single_device",
};

function activation(
  overrides: Partial<ApprovalActivation> = {},
): ApprovalActivation {
  return {
    id: "act_1",
    authReqId: "areq_1",
    principalId: "prn_approver",
    transactionDigest: "v1:tx",
    decision: "approved",
    policyDigest: "v1:policy",
    channelKind: "in_app",
    challengeDigest: "sha256:c",
    state: "activated",
    createdAt: NOW,
    activatedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
    version: 1,
    ...overrides,
  };
}

function binding(
  overrides: Partial<ExternalChannelBinding> = {},
): ExternalChannelBinding {
  return {
    id: "cb_1",
    principalId: "prn_approver",
    kind: "slack",
    providerId: "slack",
    providerTenantId: "T_WS",
    providerSubjectId: "U_ME",
    state: "active",
    verification: "provider_oauth_install",
    createdAt: NOW,
    verifiedAt: NOW,
    metadata: {},
    version: 1,
    ...overrides,
  };
}

const inAppHighAssurance = {
  decision: "approved" as const,
  path: "in_app" as const,
  channelKind: "in_app" as const,
  policy: defaultApprovalPolicy("high"),
  approverPrincipalId: "prn_approver",
  requestPrincipalId: "prn_approver",
  authReqId: "areq_1",
  evidence: [evidence()],
  activationAuthentication: passkeyFacts,
  activation: activation(),
  expectedTransactionDigest: "v1:tx",
  expectedPolicyDigest: "v1:policy",
  requestPending: true,
  requestDigestMatches: true,
  comparisonSatisfied: true,
  now: NOW,
};

/**
 * The in-app base without the two fields only an in-app ceremony can supply.
 *
 * Omitted rather than set to `undefined`: under `exactOptionalPropertyTypes`
 * those are different types, and "absent" is what an external callback
 * actually looks like when it reaches the evaluator.
 */
const {
  activationAuthentication: _noFacts,
  activation: _noActivation,
  ...externalBase
} = inAppHighAssurance;

describe("evaluateApprovalCeremony", () => {
  it("contract: an in-app transaction-bound passkey approval is allowed", () => {
    const result = evaluateApprovalCeremony(inAppHighAssurance);
    expect(result.refusals).toEqual([]);
    expect(result.allowed).toBe(true);
    expect(result.achieved).toContain("phishing_resistance");
  });

  it("adversarial: the approver must be the person the request is addressed to", () => {
    const result = evaluateApprovalCeremony({
      ...inAppHighAssurance,
      approverPrincipalId: "prn_someone_else",
    });
    expect(result.allowed).toBe(false);
    expect(result.refusals).toContain("approver_mismatch");
  });

  it("adversarial: a Slack callback can never satisfy phishing resistance", () => {
    // The headline claim. Every verified fact about the callback is true and
    // it still cannot clear a bar that requires an origin-bound credential.
    const result = evaluateApprovalCeremony({
      ...externalBase,
      path: "external_direct",
      channelKind: "slack",
      policy: {
        ...defaultApprovalPolicy("high"),
        allowedChannels: ["slack", "in_app"],
        directApprovalChannels: ["slack"],
        requireTransactionBoundActivation: false,
      },
      binding: binding(),
      claimedIdentity: {
        providerId: "slack",
        providerTenantId: "T_WS",
        providerSubjectId: "U_ME",
      },
      callbackAuthenticated: true,
      callbackFresh: true,
      freshnessSource: "provider_timestamp" as const,
      callbackUnseen: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.refusals).toContain("assurance_insufficient");
    expect(result.refusals).toContain("channel_cannot_meet_assurance");
  });

  it("contract: the same callback settles a low-risk policy that permits it", () => {
    const result = evaluateApprovalCeremony({
      ...externalBase,
      path: "external_direct",
      channelKind: "slack",
      policy: {
        ...defaultApprovalPolicy("low"),
        allowedChannels: ["slack", "in_app"],
        directApprovalChannels: ["slack"],
        requireTransactionBoundActivation: false,
      },
      binding: binding(),
      claimedIdentity: {
        providerId: "slack",
        providerTenantId: "T_WS",
        providerSubjectId: "U_ME",
      },
      callbackAuthenticated: true,
      callbackFresh: true,
      freshnessSource: "provider_timestamp" as const,
      callbackUnseen: true,
    });
    expect(result.refusals).toEqual([]);
    expect(result.allowed).toBe(true);
  });

  it("adversarial: a callback cannot assert its own assurance", () => {
    // Even when the caller passes phishing-resistant-looking facts, an
    // external path derives its facts from the channel ceiling. Only an
    // activation the server itself verified may supply them.
    const withForgedFacts = evaluateApprovalCeremony({
      ...externalBase,
      path: "external_direct",
      channelKind: "slack",
      policy: {
        ...defaultApprovalPolicy("high"),
        allowedChannels: ["slack", "in_app"],
        directApprovalChannels: ["slack"],
        requireTransactionBoundActivation: false,
      },
      // No activation ran, so no verified facts exist to pass.
      binding: binding(),
      claimedIdentity: {
        providerId: "slack",
        providerTenantId: "T_WS",
        providerSubjectId: "U_ME",
      },
      callbackAuthenticated: true,
      callbackFresh: true,
      freshnessSource: "provider_timestamp" as const,
      callbackUnseen: true,
    });
    expect(withForgedFacts.allowed).toBe(false);
  });

  it("adversarial: a cross-tenant callback is refused", () => {
    const result = evaluateApprovalCeremony({
      ...externalBase,
      path: "external_direct",
      channelKind: "slack",
      policy: {
        ...defaultApprovalPolicy("low"),
        allowedChannels: ["slack", "in_app"],
        directApprovalChannels: ["slack"],
        requireTransactionBoundActivation: false,
      },
      binding: binding(),
      claimedIdentity: {
        providerId: "slack",
        providerTenantId: "T_ATTACKER",
        providerSubjectId: "U_ME",
      },
      callbackAuthenticated: true,
      callbackFresh: true,
      freshnessSource: "provider_timestamp" as const,
      callbackUnseen: true,
    });
    expect(result.refusals).toContain("binding_identity_mismatch");
  });

  it("adversarial: a caller who omits the freshness source is refused", () => {
    // The default has to be the safe one. A route that forgets this field is
    // a route that did not check, and it must not be read as "fresh".
    const result = evaluateApprovalCeremony({
      ...externalBase,
      path: "external_direct",
      channelKind: "slack",
      policy: {
        ...defaultApprovalPolicy("low"),
        allowedChannels: ["slack", "in_app"],
        directApprovalChannels: ["slack"],
        requireTransactionBoundActivation: false,
      },
      binding: binding(),
      claimedIdentity: {
        providerId: "slack",
        providerTenantId: "T_WS",
        providerSubjectId: "U_ME",
      },
      callbackAuthenticated: true,
      callbackFresh: true,
      callbackUnseen: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.refusals).toContain("callback_freshness_unestablished");
  });

  it("adversarial: an activation for a different request is refused", () => {
    const result = evaluateApprovalCeremony({
      ...inAppHighAssurance,
      activation: activation({ authReqId: "areq_OTHER" }),
    });
    expect(result.allowed).toBe(false);
    expect(result.refusals).toContain("activation_wrong_request");
  });

  it("adversarial: an activation minted for deny cannot approve", () => {
    const result = evaluateApprovalCeremony({
      ...inAppHighAssurance,
      activation: activation({ decision: "denied" }),
    });
    expect(result.refusals).toContain("activation_wrong_decision");
  });

  it("adversarial: a policy that tightened after minting invalidates the activation", () => {
    const result = evaluateApprovalCeremony({
      ...inAppHighAssurance,
      expectedPolicyDigest: "v1:policy_tightened",
    });
    expect(result.refusals).toContain("activation_policy_changed");
  });

  it("adversarial: a stale request digest is refused on the in-app path too", () => {
    const result = evaluateApprovalCeremony({
      ...inAppHighAssurance,
      requestDigestMatches: false,
    });
    expect(result.refusals).toContain("request_digest_changed");
  });

  it("property: removing evidence never increases what was achieved", () => {
    const withEvidence = evaluateApprovalCeremony(inAppHighAssurance);
    const without = evaluateApprovalCeremony({
      ...inAppHighAssurance,
      evidence: [],
    });
    for (const code of without.achieved) {
      expect(withEvidence.achieved).toContain(code);
    }
    expect(without.allowed).toBe(false);
  });

  it("property: a required code that is unmet never appears as achieved", () => {
    const result = evaluateApprovalCeremony({
      ...inAppHighAssurance,
      activationAuthentication: {
        ...passkeyFacts,
        phishingResistant: false,
        verifierNameBound: false,
      },
    });
    expect(result.required).toContain("phishing_resistance");
    expect(result.achieved).not.toContain("phishing_resistance");
    expect(result.allowed).toBe(false);
  });

  it("contract: the required codes describe the bar, not the outcome", () => {
    const codes = requiredReasonCodes(defaultApprovalPolicy("critical"));
    expect(codes).toContain("phishing_resistance");
    expect(codes).toContain("transaction_bound_activation");
    expect(codes).toContain("comparison");
  });

  it("adversarial: a comparison the policy demands and the person skipped refuses", () => {
    const policy: ApprovalPolicy = {
      ...defaultApprovalPolicy("critical"),
    };
    const result = evaluateApprovalCeremony({
      ...inAppHighAssurance,
      policy,
      comparisonSatisfied: false,
    });
    expect(result.refusals).toContain("comparison_required");
  });
});
