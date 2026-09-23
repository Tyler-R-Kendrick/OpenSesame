import { describe, expect, it } from "vitest";
import {
  assertContextAllows,
  intersectCompartments,
  isAccessContext,
  issueAccessContext,
  publicAccessMetadata,
} from "./access/context.js";
import { AlertOutbox } from "./alert/outbox.js";
import { importAlertSealingKey, sealAlertPackage } from "./alert/seal.js";
import { parseCanaryActivation, recordCanaryHit } from "./canary/detect.js";
import {
  canaryFalsePositiveBound,
  executeCanary,
  resetCanaryStateForTests,
  revokeCanaryRoute,
} from "./canary/detect.js";
import {
  assertNoCrossCompartmentLeak,
  canRestoreLimitedCarry,
  decoyConnectorAllowed,
  projectConnectors,
  projectLimitedCarry,
  projectVisibleItems,
  resolveDecoyOrLocked,
  selectLimitedCarry,
} from "./compartment/project.js";
import {
  createIndependentCompartmentKey,
  openPrfAndCode,
  openProfileSlot,
  sealPrfAndCode,
  sealProfileSlot,
} from "./crypto/slots.js";
import { refuseUnsupportedDuressFormat } from "./feature/format.js";
import {
  compareFeatureModes,
  enrollmentAssetReadiness,
  registerDuressFeature,
  resolveDuressMode,
} from "./feature/mode.js";
import {
  generatePeerKeyPair,
  signPeerEnvelope,
  verifyPeerEnvelope,
} from "./peer/envelope.js";
import {
  combineRecoveryShares,
  countIndependentCustodians,
  roleAllows,
  splitRecoverySecret,
} from "./recovery/custody.js";
import {
  assertOwnedPath,
  executeLocalRemoval,
  isUnsupportedDestructiveAction,
} from "./removal/local-remove.js";
import { DuressSessionFence } from "./session/fence.js";
import {
  PRESET_CATALOG,
  canArmProfile,
  digestDestructiveAck,
  digestOwnerConsent,
  previewImport,
  previewImportDocument,
  redactSecrets,
  rehearsalSatisfiesArming,
  runIsolatedRehearsal,
  statusViewForPresentation,
  validateRecipientSetup,
} from "./settings/index.js";
import {
  createEmptyEnrollmentState,
  enrollTrigger,
  selectTrigger,
} from "./trigger/enrollment.js";

async function alertKeys() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return importAlertSealingKey(raw);
}

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
