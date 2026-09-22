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

describe("compartment projection", () => {
  const items = [
    {
      id: "1",
      compartmentRef: "decoy",
      title: "Bank",
      sensitive: false,
      folder: "daily",
      hasTotp: true,
    },
    {
      id: "2",
      compartmentRef: "real",
      title: "Root key",
      sensitive: true,
      folder: "secrets",
      hasPasskey: true,
    },
  ];

  it("scopes search/counts and never falls back to real vault on corrupt decoy", () => {
    const visible = projectVisibleItems(items, ["decoy"], "decoy", {
      search: "bank",
    });
    expect(visible.map((i) => i.id)).toEqual(["1"]);
    assertNoCrossCompartmentLeak(visible, ["decoy"]);
    expect(resolveDecoyOrLocked(false, false)).toBe("locked");
    expect(resolveDecoyOrLocked(true, true)).toBe("locked");
    expect(decoyConnectorAllowed("decoy", false)).toBe(false);
    expect(projectConnectors(["c1", "c2"], "decoy", new Set(["c2"]))).toEqual([
      "c2",
    ]);
  });

  it("limited-carry requires separate restore context", () => {
    const selection = selectLimitedCarry(items, ["1"], "restore-ctx");
    expect(projectLimitedCarry(items, selection, "restricted")).toHaveLength(1);
    expect(canRestoreLimitedCarry(selection, "restore-ctx")).toBe(false);
    expect(canRestoreLimitedCarry(selection, "active-ctx")).toBe(true);
  });
});
