import { describe, expect, it } from "vitest";
import {
  PRESET_CATALOG,
  canArmProfile,
  digestDestructiveAck,
  digestOwnerConsent,
  previewImport,
  redactSecrets,
  rehearsalSatisfiesArming,
  runIsolatedRehearsal,
  statusViewForPresentation,
  validateRecipientSetup,
} from "./settings/index.js";

describe("settings consent + rehearsal", () => {
  it("digests consent, rehearses without arming, redacts codes", async () => {
    expect(PRESET_CATALOG.length).toBeGreaterThanOrEqual(13);
    const consentDigest = await digestOwnerConsent({
      ownerPrincipalRef: "owner-1",
      policyId: "pol-1",
      policyRevision: 1,
      profileIds: ["SC-RESTRICTED"],
      exposureDigestMaterial: "expose-v1",
      acknowledgedAt: new Date().toISOString(),
    });
    expect(consentDigest).toMatch(/^[a-f0-9]{64}$/);
    const destructive = await digestDestructiveAck({
      removalResourceRefs: ["comp-1"],
      acceptUnrecoverability: true,
      holdDisclosureAck: true,
      acknowledgedAt: new Date().toISOString(),
    });
    expect(destructive).toMatch(/^[a-f0-9]{64}$/);

    const rehearsal = runIsolatedRehearsal({
      disposableFixtures: true,
      durableStorage: true,
      offlineAssetsReady: true,
      triggerSelectsExactlyOne: true,
      presentationClass: "restricted",
      expectedPresentationClass: "restricted",
      attemptedProductionAlert: false,
      attemptedProductionRemoval: false,
    });
    expect(rehearsal.productionEffectsApplied).toBe(false);
    expect(rehearsalSatisfiesArming(rehearsal)).toBe(true);
    expect(redactSecrets({ unlockCode: "01234567", ok: true })).toEqual({
      unlockCode: "[redacted]",
      ok: true,
    });
    expect(
      canArmProfile({
        ownerConsent: true,
        destructiveAck: true,
        rehearsalPassed: true,
        durableStorage: true,
        enrolledTriggers: true,
        exposureReviewed: true,
      }),
    ).toBe(true);
    expect(
      validateRecipientSetup(
        [
          {
            role: "alert_recipient",
            label: "Friend",
            ref: "r1",
            cannot: ["Cannot unlock vaults"],
          },
        ],
        { recipient: true, custodian: false },
      ).ok,
    ).toBe(true);
  });

  it("hides sensitive labels on decoy/restricted status views", () => {
    const decoy = statusViewForPresentation("decoy", true);
    expect(decoy.showPolicyLabels).toBe(false);
    expect(decoy.showIncidentIds).toBe(false);
    const restricted = statusViewForPresentation("restricted", true);
    expect(restricted.showRecoveryControls).toBe(false);
  });

  it("import preview never arms and redacts secrets", () => {
    const preview = previewImport(
      JSON.stringify({
        schemaVersion: 1,
        policyId: "p",
        revision: 1,
        enabled: true,
        profiles: [],
        unlockCode: "secret",
      }),
      {
        ownerPrincipalRefs: [],
        organizationRefs: [],
        vaultRefs: [],
        deviceBindingRefs: [],
        compartmentRefs: [],
        independentCompartmentRefs: [],
        routeRefs: [],
        peerRefs: [],
        providerActionRefs: [],
        recoveryPolicyRefs: [],
        operationCeilingRefs: [],
        authorityRefs: [],
        durableStorage: true,
        alternateUnlockPaths: [],
      },
    );
    expect(preview.armed).toBe(false);
    // enabled:true must not arm; secrets must not remain on a successful parse.
    if (preview.parseOk && preview.document) {
      expect(preview.warnings.some((w) => /preview only/i.test(w))).toBe(true);
      expect(JSON.stringify(preview.document)).not.toMatch(/secret/);
    } else {
      expect(preview.warnings.length).toBeGreaterThan(0);
    }
  });
});
