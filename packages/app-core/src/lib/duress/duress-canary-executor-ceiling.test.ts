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

describe("canary executor ceiling", () => {
  it("rejects destructive params, dedups, and honors revoke", () => {
    resetCanaryStateForTests();
    const id = "canary-honeytoken-1";
    expect(
      executeCanary({
        event: { version: 1, canaryId: id, routeRef: "route-alert-1" },
        enrolledRouteRefs: ["route-alert-1"],
        action: "wipe",
      }).ok,
    ).toBe(false);
    expect(
      executeCanary({
        event: {
          version: 1,
          canaryId: id,
          routeRef: "route-alert-1",
          wipe: true,
        },
        enrolledRouteRefs: ["route-alert-1"],
      }).ok,
    ).toBe(false);
    const a = executeCanary({
      event: { version: 1, canaryId: id, routeRef: "route-alert-1" },
      enrolledRouteRefs: ["route-alert-1"],
    });
    expect(a).toMatchObject({ ok: true });
    if (!a.ok) throw new Error(`expected ok, got ${JSON.stringify(a)}`);
    expect(a.result.kind).toBe("detection_only");
    expect(a.result.notified).toBe(true);
    const b = executeCanary({
      event: { version: 1, canaryId: id, routeRef: "route-alert-1" },
      enrolledRouteRefs: ["route-alert-1"],
    });
    expect(b).toMatchObject({ ok: true });
    if (!b.ok) throw new Error("expected ok");
    expect(b.result.deduped).toBe(true);
    const bound = canaryFalsePositiveBound([a.result, b.result]);
    expect(bound.notifications).toBe(1);
    revokeCanaryRoute("route-alert-1");
    const revoked = executeCanary({
      event: {
        version: 1,
        canaryId: "canary-honeytoken-2",
        routeRef: "route-alert-1",
      },
      enrolledRouteRefs: ["route-alert-1"],
    });
    expect(revoked).toMatchObject({ ok: true });
    if (!revoked.ok) throw new Error("expected ok");
    expect(revoked.result.notified).toBe(false);
  });
});
