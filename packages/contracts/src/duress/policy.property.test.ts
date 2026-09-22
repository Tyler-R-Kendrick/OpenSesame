import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defined } from "./defined.js";
import {
  type CompilerCatalog,
  type PolicyDocument,
  PolicyDocumentSchema,
  compileDuressPolicy,
  diffDuressPolicies,
  policyDigest,
  roundTripDuressPolicy,
} from "./index.js";

const catalog: CompilerCatalog = {
  ownerPrincipalRefs: ["owner-1"],
  organizationRefs: [],
  vaultRefs: ["vault-1"],
  deviceBindingRefs: ["device-1"],
  compartmentRefs: ["comp-normal", "comp-decoy"],
  independentCompartmentRefs: ["comp-decoy"],
  routeRefs: ["route-alert-1"],
  peerRefs: [],
  providerActionRefs: [],
  recoveryPolicyRefs: ["recovery-1"],
  operationCeilingRefs: ["ceiling-restricted"],
  authorityRefs: [],
  durableStorage: true,
  alternateUnlockPaths: [],
};

const validAlertDoc = {
  schemaVersion: 1 as const,
  policyId: "pol-prop",
  revision: 1,
  enabled: false,
  profiles: [
    {
      profileId: "alert",
      label: "Alert",
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
          templateRef: "tpl",
          retainOutboxAcrossRemoval: false,
          maxRetries: 1,
          expiryMs: 60_000,
        },
        quarantinePeerRefs: [],
        providerRevocationRefs: [],
        removal: { kind: "none" },
        recoveryPolicyRef: null,
        operationCeilingRef: null,
      },
    },
  ],
} satisfies PolicyDocument;

describe("duress policy properties", () => {
  const baseProfile = defined(validAlertDoc.profiles[0], "value");
  it("rejects unknown security-altering fields", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 32 }), (key) => {
        fc.pre(
          ![
            "schemaVersion",
            "policyId",
            "revision",
            "enabled",
            "profiles",
          ].includes(key),
        );
        const poisoned = { ...validAlertDoc, [key]: true };
        const parsed = PolicyDocumentSchema.safeParse(poisoned);
        expect(parsed.success).toBe(false);
      }),
      { numRuns: 50 },
    );
  });

  it("rejects oversized collections and strings", () => {
    const tooManyProfiles = {
      ...validAlertDoc,
      profiles: Array.from({ length: 33 }, (_, i) => ({
        ...defined(validAlertDoc.profiles[0], "value"),
        profileId: `p-${i}`,
      })),
    };
    expect(PolicyDocumentSchema.safeParse(tooManyProfiles).success).toBe(false);

    const longLabel = {
      ...validAlertDoc,
      profiles: [
        {
          ...defined(validAlertDoc.profiles[0], "value"),
          label: "x".repeat(121),
        },
      ],
    };
    expect(PolicyDocumentSchema.safeParse(longLabel).success).toBe(false);
  });

  it("rejects scope expansion beyond catalog", () => {
    const expanded = {
      ...validAlertDoc,
      profiles: [
        {
          ...defined(validAlertDoc.profiles[0], "value"),
          scope: {
            ...baseProfile.scope,
            compartmentRefs: ["comp-normal", "comp-foreign"],
          },
        },
      ],
    };
    const result = compileDuressPolicy(expanded, catalog);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "scope_mismatch")).toBe(
        true,
      );
    }
  });

  it("composes conflict diagnostics without arming", () => {
    const conflict = {
      ...validAlertDoc,
      enabled: true,
      profiles: [
        {
          ...defined(validAlertDoc.profiles[0], "value"),
          profileId: "canary",
          triggerKind: "canary_activation" as const,
          effects: {
            ...baseProfile.effects,
            presentation: "unchanged" as const,
            removal: {
              kind: "local_enumerated" as const,
              resourceRefs: ["comp-normal"],
              preserveSealedOutbox: false,
              acceptUnrecoverability: true,
            },
          },
        },
      ],
    };
    const result = compileDuressPolicy(conflict, catalog);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it("policy digests are deterministic and ignore enabled", () => {
    const a = PolicyDocumentSchema.parse(validAlertDoc);
    const b = PolicyDocumentSchema.parse({ ...validAlertDoc, enabled: true });
    expect(policyDigest(a)).toBe(policyDigest(b));
    expect(policyDigest(a)).toBe(policyDigest(a));
  });

  it("yaml/json round-trip preserves digest", () => {
    const doc = PolicyDocumentSchema.parse(validAlertDoc);
    for (const format of ["json", "yaml"] as const) {
      const round = roundTripDuressPolicy(doc, format);
      expect(policyDigest(round)).toBe(policyDigest(doc));
    }
  });

  it("diff never claims arm or clear", () => {
    const before = PolicyDocumentSchema.parse(validAlertDoc);
    const after = PolicyDocumentSchema.parse({
      ...validAlertDoc,
      revision: 2,
      enabled: true,
      profiles: [
        defined(validAlertDoc.profiles[0], "value"),
        {
          ...defined(validAlertDoc.profiles[0], "value"),
          profileId: "extra",
        },
      ],
    });
    const diff = diffDuressPolicies(before, after);
    expect(diff.wouldArm).toBe(false);
    expect(diff.wouldClear).toBe(false);
    expect(diff.addedProfileIds).toContain("extra");
    expect(diff.revisionDelta).toBe(1);
  });
});
