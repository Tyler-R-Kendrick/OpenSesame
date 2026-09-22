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

describe("COMPARTMENT-UX-D limited-carry", () => {
  it("materializes an independent carry compartment and restores in a separate context", async () => {
    const source = [
      { id: "1", title: "Transit card", folder: "travel", secret: "ok" },
      { id: "2", title: "Root vault entry", folder: "secrets", secret: "NO" },
    ];
    const plan = buildLimitedCarryPlan({
      sourceItems: source,
      itemIds: ["1"],
      carryCompartmentRef: "comp-carry",
      restoreContextId: "restore-ctx",
      removeFromSource: true,
    });
    expect(plan.exposurePreview.historicalCopyDisclosure).toBe(true);
    expect(plan.exposurePreview.carriedTitles).toEqual(["Transit card"]);

    const bundle = await materializeLimitedCarry({
      plan,
      sourceItems: source,
      keyEpoch: 3,
    });
    expect(bundle.sourceRemaining.map((i) => i.id)).toEqual(["2"]);
    expect(bundle.published.independentRoot).toBe(true);

    const same = await restoreLimitedCarryOffline({
      bundle,
      activeContextId: "restore-ctx",
      restoreContextId: "restore-ctx",
    });
    expect(same).toEqual({ ok: false, code: "same_context" });

    const restored = await restoreLimitedCarryOffline({
      bundle,
      activeContextId: "active-duress",
      restoreContextId: "restore-ctx",
    });
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.view.items.map((i) => i.title)).toEqual(["Transit card"]);
      expect(restored.view.locked).toBe(false);
    }
  });
});
