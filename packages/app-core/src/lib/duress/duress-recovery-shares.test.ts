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

describe("recovery shares", () => {
  it("reconstructs 2-of-3 and rejects one share (AT-065/066)", async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const macKey = crypto.getRandomValues(new Uint8Array(32));
    const shares = await splitRecoverySecret({
      secret,
      threshold: 2,
      total: 3,
      generation: 1,
      vaultRef: "v1",
      compartmentRef: "c1",
      policyRevision: 1,
      keyEpoch: 1,
      macKey,
    });
    await expect(
      combineRecoveryShares({
        shares: shares.slice(0, 1),
        macKey,
        expect: {
          generation: 1,
          vaultRef: "v1",
          compartmentRef: "c1",
          policyRevision: 1,
          keyEpoch: 1,
          threshold: 2,
        },
      }),
    ).rejects.toThrow(/insufficient/);
    const out = await combineRecoveryShares({
      shares: shares.slice(0, 2),
      macKey,
      expect: {
        generation: 1,
        vaultRef: "v1",
        compartmentRef: "c1",
        policyRevision: 1,
        keyEpoch: 1,
        threshold: 2,
      },
    });
    expect([...out]).toEqual([...secret]);
    expect(
      countIndependentCustodians([
        {
          principalRef: "a",
          role: "key_custodian",
          custodyDomain: "icloud-sync",
          scopeRef: "c1",
          generation: 1,
        },
        {
          principalRef: "b",
          role: "key_custodian",
          custodyDomain: "icloud-sync",
          scopeRef: "c1",
          generation: 1,
        },
      ]),
    ).toBe(1);
    expect(
      roleAllows(
        {
          principalRef: "r",
          role: "alert_recipient",
          custodyDomain: "phone",
          scopeRef: "c1",
          generation: 1,
        },
        "release_share",
      ),
    ).toBe(false);
  });
});
