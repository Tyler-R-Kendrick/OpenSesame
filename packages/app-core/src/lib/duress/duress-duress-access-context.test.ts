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
import { overlapCast } from "./json-boundary.js";
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

describe("duress access context", () => {
  it("rejects forged JSON copies (AT-032)", () => {
    const ctx = issueAccessContext({
      principalRef: "p1",
      tenantRef: null,
      vaultRef: "v1",
      compartmentRefs: ["c1"],
      deviceBindingRef: "d1",
      presentation: "restricted",
      authorizationCeiling: ["read_item"],
      denyOperations: ["export_root"],
      policyRevision: 1,
      incidentEpoch: 1,
      keyEpoch: 1,
      sessionGeneration: 1,
      profileId: "prof",
      evidenceDigest: "abc123abc123abc1",
    });
    expect(isAccessContext(ctx)).toBe(true);
    const copy = { ...publicAccessMetadata(ctx), claims: ctx.claims };
    expect(
      isAccessContext(
        overlapCast<import("./access/context.js").AccessContextProbe>(copy),
      ),
    ).toBe(false);
  });

  it("intersects compartments across incidents (AT-039)", () => {
    expect(
      intersectCompartments([
        ["a", "b"],
        ["b", "c"],
      ]),
    ).toEqual(["b"]);
  });
});
