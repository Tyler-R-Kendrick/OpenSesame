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

describe("COMPARTMENT-UX-F leakage + offline limited-carry", () => {
  it("blocks cross-compartment DOM/accessible leakage and completes offline carry", async () => {
    const protectedComp = await createKeyedCompartment({
      compartmentRef: "comp-real",
      kind: "restricted",
      label: "Real",
      keyEpoch: 1,
      items: [
        {
          id: "p1",
          title: "PROTECTED-TITLE-DO-NOT-LEAK",
          secret: "root",
          connectorRef: "prod-sync",
        },
      ],
    });
    const decoy = await createKeyedCompartment({
      compartmentRef: "comp-decoy",
      kind: "decoy",
      label: "Decoy",
      keyEpoch: 1,
      items: [{ id: "d1", title: "Public looking item", secret: "ok" }],
    });

    const decoySession = await mintPresentationSession({
      presentation: "decoy",
      profileId: "decoy",
      contextId: "decoy-ctx",
      admittedKeys: [
        {
          compartmentRef: decoy.compartmentRef,
          keyEpoch: decoy.keyEpoch,
          rawKey: decoy.rawKey,
        },
      ],
    });
    const outcome = await openPresentation(decoySession, decoy, {
      expectKind: "decoy",
    });
    const view = projectScopedView(outcome, { search: "PROTECTED" });
    expect(view.items).toEqual([]);
    assertNoProtectedLeak(view, ["PROTECTED-TITLE-DO-NOT-LEAK"]);
    const tree = accessibleProjection(view);
    expect(tree.textNodes.join(" ")).not.toContain(
      "PROTECTED-TITLE-DO-NOT-LEAK",
    );

    // Project-switch: session only admits decoy — cannot open protected
    const switchAttempt = await openPresentation(decoySession, protectedComp);
    expect(switchAttempt.kind).toBe("locked");

    // Real connector contamination refused
    const contaminated = decideConnectorAttach({
      presentation: "decoy",
      connectionRef: "prod-sync",
      authorityClass: "production",
      changesProductionCredentials: false,
      approval: null,
    });
    expect(contaminated.ok).toBe(false);

    // Offline limited-carry journey (no network)
    const plan = buildLimitedCarryPlan({
      sourceItems: [
        { id: "c1", title: "Carry me", secret: "token" },
        { id: "c2", title: "Leave behind", secret: "no" },
      ],
      itemIds: ["c1"],
      carryCompartmentRef: "comp-carry",
      restoreContextId: "offline-restore",
      removeFromSource: true,
    });
    const bundle = await materializeLimitedCarry({
      plan,
      sourceItems: [
        { id: "c1", title: "Carry me", secret: "token" },
        { id: "c2", title: "Leave behind", secret: "no" },
      ],
      keyEpoch: 9,
    });
    const restored = await restoreLimitedCarryOffline({
      bundle,
      activeContextId: "offline-active",
      restoreContextId: "offline-restore",
    });
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.view.items.map((i) => i.id)).toEqual(["c1"]);
      assertNoProtectedLeak(restored.view, [
        "Leave behind",
        "PROTECTED-TITLE-DO-NOT-LEAK",
      ]);
    }
  });
});
