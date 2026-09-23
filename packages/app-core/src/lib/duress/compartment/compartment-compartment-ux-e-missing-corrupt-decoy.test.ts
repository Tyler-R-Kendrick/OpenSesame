/**
 * COMPARTMENT-UX tests — independent-key compartments, scope, connectors,
 * limited-carry, locked fallback, leakage / offline journey (A–F).
 */

import { describe, expect, it } from "vitest";
import { createIndependentCompartmentKey } from "../crypto/slots.js";
import {
  accessibleProjection,
  approveSafeLowAuthorityConnection,
  assertNoProtectedLeak,
  attachmentPreviewAllowed,
  buildLimitedCarryPlan,
  buildTopology,
  createKeyedCompartment,
  decideConnectorAttach,
  itemPreview,
  materializeLimitedCarry,
  mintPresentationSession,
  openPresentation,
  passkeyActionAllowed,
  projectScopedView,
  requireIndependentPresentation,
  restoreLimitedCarryOffline,
  totpActionAllowed,
  tryOpenWithForeignKey,
  updateDecoyContents,
} from "./index.js";

describe("COMPARTMENT-UX-E missing/corrupt decoy", () => {
  it("yields locked presentation and never falls back to foreign vault material", async () => {
    const decoy = await createKeyedCompartment({
      compartmentRef: "comp-decoy",
      kind: "decoy",
      label: "Decoy",
      keyEpoch: 1,
      items: [{ id: "d1", title: "Harmless", secret: "x" }],
    });
    const protectedVault = await createKeyedCompartment({
      compartmentRef: "comp-real",
      kind: "restricted",
      label: "Real",
      keyEpoch: 1,
      items: [
        { id: "secret", title: "PRODUCTION SECRET", secret: "classified" },
      ],
    });

    const session = await mintPresentationSession({
      presentation: "decoy",
      profileId: "decoy",
      contextId: "s",
      admittedKeys: [
        {
          compartmentRef: decoy.compartmentRef,
          keyEpoch: decoy.keyEpoch,
          rawKey: decoy.rawKey,
        },
      ],
    });

    const missing = await openPresentation(session, null, {
      expectKind: "decoy",
    });
    expect(missing.kind).toBe("locked");
    if (missing.kind === "locked") {
      expect(missing.reason).toBe("missing_decoy");
      expect(missing.session.presentation).toBe("locked");
    }
    const missingView = projectScopedView(missing);
    expect(missingView.items).toEqual([]);
    assertNoProtectedLeak(missingView, ["PRODUCTION SECRET"]);

    const corrupt = {
      ...decoy,
      sealed: {
        ...decoy.sealed,
        ctB64: btoa("not-valid-ciphertext!!!!!"),
      },
    };
    const bad = await openPresentation(session, corrupt, {
      expectKind: "decoy",
    });
    expect(bad.kind).toBe("locked");
    if (bad.kind === "locked") expect(bad.reason).toBe("corrupt_decoy");

    // Even with real vault published nearby, locked outcome must not open it
    const realAttempt = await openPresentation(
      { ...session, presentation: "locked" },
      protectedVault,
    );
    expect(realAttempt.kind).toBe("locked");
    expect(
      await tryOpenWithForeignKey(decoy.rawKey, protectedVault),
    ).toBeNull();
  });
});
