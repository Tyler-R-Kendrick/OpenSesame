import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  type CompilerCatalog,
  compileDuressPolicy,
  dryRunDuressPolicy,
} from "./index.js";
import {
  type PolicyDocument,
  PolicyDocumentSchema,
  type PolicyProfile,
  PolicyProfileSchema,
} from "./policy.js";

const catalog: CompilerCatalog = {
  ownerPrincipalRefs: ["owner-1"],
  organizationRefs: ["org-1"],
  vaultRefs: ["vault-1"],
  deviceBindingRefs: ["device-1"],
  compartmentRefs: ["comp-normal", "comp-decoy", "comp-restricted"],
  independentCompartmentRefs: ["comp-decoy", "comp-restricted"],
  routeRefs: ["route-alert-1"],
  peerRefs: ["peer-1"],
  providerActionRefs: [],
  recoveryPolicyRefs: ["recovery-1"],
  operationCeilingRefs: ["ceiling-restricted"],
  authorityRefs: ["host-authority-1"],
  durableStorage: true,
  alternateUnlockPaths: [],
};

const defaultProfile = {
  profileId: "profile-alert",
  label: "Alert only",
  scope: {
    ownerPrincipalRef: "owner-1",
    organizationRef: null,
    vaultRef: "vault-1",
    deviceBindingRef: "device-1",
    compartmentRefs: ["comp-normal"],
  },
  triggerKind: "application_code",
  effects: {
    presentation: "normal",
    presentationCompartmentRef: null,
    hold: { kind: "none" },
    alert: {
      routeRef: "route-alert-1",
      templateRef: "tpl-1",
      retainOutboxAcrossRemoval: false,
      maxRetries: 3,
      expiryMs: 3_600_000,
    },
    quarantinePeerRefs: [],
    providerRevocationRefs: [],
    removal: { kind: "none" },
    recoveryPolicyRef: null,
    operationCeilingRef: null,
  },
} satisfies PolicyProfile;

function policyDocument(
  profiles: PolicyProfile[],
  overrides: Partial<
    Pick<PolicyDocument, "policyId" | "revision" | "enabled">
  > = {},
): PolicyDocument {
  return PolicyDocumentSchema.parse({
    schemaVersion: 1,
    policyId: "pol-1",
    revision: 1,
    enabled: false,
    profiles,
    ...overrides,
  });
}

function baseProfile(overrides: Partial<PolicyProfile> = {}): PolicyProfile {
  return PolicyProfileSchema.parse({
    ...defaultProfile,
    ...overrides,
    scope: overrides.scope
      ? { ...defaultProfile.scope, ...overrides.scope }
      : defaultProfile.scope,
    effects: overrides.effects
      ? { ...defaultProfile.effects, ...overrides.effects }
      : defaultProfile.effects,
  });
}

describe("compileDuressPolicy", () => {
  it("accepts alert-only and never arms on import (AT-002)", () => {
    const doc = policyDocument([baseProfile()], { enabled: true });
    const result = compileDuressPolicy(doc, catalog);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.armed).toBe(false);
      expect(result.exposures[0]?.admittedCompartmentRefs).toContain(
        "comp-normal",
      );
    }
    const dry = dryRunDuressPolicy(doc, catalog, {
      ownerConsent: false,
      rehearsalPassed: false,
      durableStorage: true,
      enrolledTriggers: false,
    });
    expect(dry.wouldArm).toBe(false);
    expect(dry.missingReadiness).toContain("owner_consent");
  });

  it("rejects decoy without independent keys", () => {
    const doc = policyDocument([
      baseProfile({
        profileId: "decoy",
        effects: {
          presentation: "decoy",
          presentationCompartmentRef: "comp-normal",
          hold: { kind: "none" },
          alert: null,
          quarantinePeerRefs: [],
          providerRevocationRefs: [],
          removal: { kind: "none" },
          recoveryPolicyRef: null,
          operationCeilingRef: "ceiling-restricted",
        },
      }),
    ]);
    const result = compileDuressPolicy(doc, catalog);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.diagnostics.some((d) => d.code === "independent_keys_required"),
      ).toBe(true);
    }
  });

  it("rejects canary with removal", () => {
    const doc = policyDocument([
      baseProfile({
        profileId: "canary",
        triggerKind: "canary_activation",
        effects: {
          presentation: "unchanged",
          presentationCompartmentRef: null,
          hold: { kind: "none" },
          alert: {
            routeRef: "route-alert-1",
            templateRef: "tpl-canary",
            retainOutboxAcrossRemoval: false,
            maxRetries: 1,
            expiryMs: 60_000,
          },
          quarantinePeerRefs: [],
          providerRevocationRefs: [],
          removal: {
            kind: "local_enumerated",
            resourceRefs: ["comp-normal"],
            preserveSealedOutbox: false,
            acceptUnrecoverability: true,
          },
          recoveryPolicyRef: null,
          operationCeilingRef: null,
        },
      }),
    ]);
    const result = compileDuressPolicy(doc, catalog);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.diagnostics.some((d) => d.code === "contradictory_actions"),
      ).toBe(true);
    }
  });

  it("rejects unknown fields that alter security interpretation", () => {
    const result = compileDuressPolicy(
      overlapCast({ ...policyDocument([baseProfile()]), silentBypass: true }),
      catalog,
    );
    expect(result.ok).toBe(false);
  });
});

describe("compileDuressPolicy additional codes", () => {
  it("flags stale_policy and retired_device", () => {
    const doc = policyDocument([baseProfile()]);
    const stale = compileDuressPolicy(doc, {
      ...catalog,
      minPolicyRevision: 9,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.diagnostics.some((d) => d.code === "stale_policy")).toBe(
        true,
      );
    }

    const retiredDoc = policyDocument([
      baseProfile({
        scope: {
          ownerPrincipalRef: "owner-1",
          organizationRef: null,
          vaultRef: "vault-1",
          deviceBindingRef: "device-1",
          compartmentRefs: ["comp-normal"],
        },
      }),
    ]);
    const retired = compileDuressPolicy(retiredDoc, {
      ...catalog,
      retiredDeviceBindingRefs: ["device-1"],
    });
    expect(retired.ok).toBe(false);
    if (!retired.ok) {
      expect(retired.diagnostics.some((d) => d.code === "retired_device")).toBe(
        true,
      );
    }
  });

  it("elevates assurance to verified_ready when catalog says so", () => {
    const doc = policyDocument([baseProfile()]);
    const result = compileDuressPolicy(doc, {
      ...catalog,
      verifiedReadyEffects: ["alert", "presentation"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.assurances.some(
          (a) => a.effect === "alert" && a.level === "verified_ready",
        ),
      ).toBe(true);
    }
  });
});
