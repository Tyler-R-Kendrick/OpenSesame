import {
  type CompilerCatalog,
  type PolicyDocument,
  PolicyDocumentSchema,
  type PolicyProfile,
  PolicyProfileSchema,
  compileDuressPolicy,
} from "@opensesame/contracts";
/**
 * Package-level duress compiler fuzz (REDTEAM-C) — no apps/pages imports.
 */
import { describe, expect, it } from "vitest";
import { DURESS_ATTACK_TREES } from "./attack-trees.js";

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

function baseDoc(
  profileOverrides: Partial<PolicyProfile> = {},
): PolicyDocument {
  return PolicyDocumentSchema.parse({
    schemaVersion: 1,
    policyId: "pol-rt-pkg",
    revision: 1,
    enabled: true,
    profiles: [baseProfile(profileOverrides)],
  });
}

describe("packages/redteam duress attack catalog", () => {
  it("covers coercion/peer/stale/backup/partial trees", () => {
    expect(DURESS_ATTACK_TREES.length).toBeGreaterThanOrEqual(5);
    const ids = new Set(DURESS_ATTACK_TREES.map((t) => t.id));
    expect(ids.size).toBe(DURESS_ATTACK_TREES.length);
  });
});

describe("packages/redteam duress compiler fuzz", () => {
  it("rejects empty / malformed documents", () => {
    expect(PolicyDocumentSchema.safeParse(undefined).success).toBe(false);
    expect(PolicyDocumentSchema.safeParse({}).success).toBe(false);
    expect(PolicyDocumentSchema.safeParse(baseDoc()).success).toBe(true);
  });

  it("never arms on import (AT-002)", () => {
    const result = compileDuressPolicy(baseDoc(), catalog);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.armed).toBe(false);
  });

  it("rejects decoy without independent compartment keys", () => {
    const doc = baseDoc({
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
        operationCeilingRef: null,
      },
    });
    const result = compileDuressPolicy(doc, catalog);
    expect(result.ok).toBe(false);
  });

  it("mutates revision/bounds and expects schema or compile fail-closed", () => {
    expect(
      PolicyDocumentSchema.safeParse({
        ...baseDoc(),
        revision: -1,
      }).success,
    ).toBe(false);

    const undisclosedHold = baseDoc({
      effects: {
        presentation: "restricted",
        presentationCompartmentRef: "comp-restricted",
        hold: {
          kind: "local_application",
          durationMs: "indefinite",
          disclosureAck: true,
        },
        alert: null,
        quarantinePeerRefs: [],
        providerRevocationRefs: [],
        removal: { kind: "none" },
        recoveryPolicyRef: null,
        operationCeilingRef: "ceiling-restricted",
      },
    });
    const result = compileDuressPolicy(undisclosedHold, catalog);
    // indefinite local hold without recoveryPolicyRef must fail
    expect(result.ok).toBe(false);
  });

  it("prf_and_code with alternateUnlockPaths bypassesClaim fails", () => {
    const doc = baseDoc({
      triggerKind: "prf_and_code",
      effects: {
        presentation: "decoy",
        presentationCompartmentRef: "comp-decoy",
        hold: { kind: "none" },
        alert: null,
        quarantinePeerRefs: [],
        providerRevocationRefs: [],
        removal: { kind: "none" },
        recoveryPolicyRef: null,
        operationCeilingRef: null,
      },
    });
    const result = compileDuressPolicy(doc, {
      ...catalog,
      alternateUnlockPaths: [
        { label: "project-key-share", bypassesClaim: true },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.diagnostics.some((d) => d.code === "alternate_unlock_bypass"),
      ).toBe(true);
    }
  });

  it("nondurable storage fails closed when catalog says so (finding RT-CONTRACT-001)", () => {
    const result = compileDuressPolicy(baseDoc(), {
      ...catalog,
      durableStorage: false,
    });
    expect(result.ok).toBe(false);
  });
});
