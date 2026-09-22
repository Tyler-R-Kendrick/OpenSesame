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
import { defined } from "./defined.js";
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

describe("duress slots + prf-and-code", () => {
  it("round-trips code slot and requires both PRF and code (AT-020..022)", async () => {
    const key = createIndependentCompartmentKey();
    const slot = await sealProfileSlot({
      code: "12345678",
      slotId: "s1",
      profileId: "p1",
      vaultRef: "v1",
      deviceBindingRef: "d1",
      policyRevision: 1,
      keyEpoch: 1,
      plaintext: {
        compartmentKey: key,
        actionCapability: null,
        presentation: "decoy",
      },
    });
    const opened = await openProfileSlot("12345678", slot, {
      vaultRef: "v1",
      deviceBindingRef: "d1",
      policyRevision: 1,
      keyEpoch: 1,
    });
    expect(opened?.presentation).toBe("decoy");

    const prf = crypto.getRandomValues(new Uint8Array(32));
    const env = await sealPrfAndCode({
      prfOutput: prf,
      code: "87654321",
      compartmentKey: key,
      profileId: "p1",
      vaultRef: "v1",
      policyRevision: 1,
      keyEpoch: 1,
    });
    expect(
      await openPrfAndCode({ prfOutput: prf, code: null, envelope: env }),
    ).toBeNull();
    expect(
      await openPrfAndCode({
        prfOutput: null,
        code: "87654321",
        envelope: env,
      }),
    ).toBeNull();
    const both = await openPrfAndCode({
      prfOutput: prf,
      code: "87654321",
      envelope: env,
    });
    expect(both).not.toBeNull();
    expect([...defined(both, "both")]).toEqual([...key]);
  });
});
