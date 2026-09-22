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

describe("peer envelopes", () => {
  it("verifies signatures and rejects wrong audience", async () => {
    const kp = await generatePeerKeyPair();
    const env = await signPeerEnvelope(
      {
        issuer: "device-a",
        audience: "receiver-1",
        principalRef: "p1",
        vaultRef: "v1",
        deviceBindingRef: "d1",
        operation: "quarantine_device",
        incidentId: "i1",
        policyRevision: 1,
        keyEpoch: 1,
        nonce: "n1",
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ciphertextB64: btoa("hi"),
      },
      kp.privateKey,
    );
    const seen = new Set<string>();
    expect(
      await verifyPeerEnvelope(
        env,
        kp.publicKey,
        { audience: "receiver-1", permittedOperations: ["quarantine_device"] },
        seen,
      ),
    ).toEqual({ ok: true });
    expect(
      await verifyPeerEnvelope(
        env,
        kp.publicKey,
        { audience: "other", permittedOperations: ["quarantine_device"] },
        new Set(),
      ),
    ).toMatchObject({ ok: false });
  });
});
