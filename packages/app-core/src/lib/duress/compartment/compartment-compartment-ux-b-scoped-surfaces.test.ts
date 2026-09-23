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

describe("COMPARTMENT-UX-B scoped surfaces", () => {
  it("scopes search, counts, history, folders, previews, TOTP/passkey, connectors", async () => {
    const decoy = await createKeyedCompartment({
      compartmentRef: "comp-decoy",
      kind: "decoy",
      label: "Decoy",
      keyEpoch: 2,
      items: [
        {
          id: "a",
          title: "Alpha bank",
          folder: "finance",
          hasTotp: true,
          hasPasskey: true,
          hasAttachment: true,
          preview: "••••1234",
          history: ["copied otp"],
          connectorRef: "prod-sync",
        },
        {
          id: "b",
          title: "Beta notes",
          folder: "notes",
          hasTotp: false,
          history: ["edited"],
          connectorRef: "safe-rss",
        },
      ],
    });
    const session = await mintPresentationSession({
      presentation: "decoy",
      profileId: "decoy",
      contextId: "s1",
      admittedKeys: [
        {
          compartmentRef: decoy.compartmentRef,
          keyEpoch: decoy.keyEpoch,
          rawKey: decoy.rawKey,
        },
      ],
    });
    const outcome = await openPresentation(session, decoy, {
      expectKind: "decoy",
    });
    const approvals = new Set(["safe-rss"]);
    const view = projectScopedView(outcome, { search: "beta" }, approvals);
    expect(view.items.map((i) => i.id)).toEqual(["b"]);
    expect(view.folders).toEqual(["notes"]);
    expect(view.history).toEqual(["edited"]);
    expect(view.counts.total).toBe(1);
    expect(view.connectors).toEqual(["safe-rss"]);

    const full = projectScopedView(outcome, {}, approvals);
    expect(itemPreview(full, "a")?.preview).toBe("••••1234");
    expect(totpActionAllowed(full, "a")).toBe(true);
    expect(passkeyActionAllowed(full, "a")).toBe(true);
    expect(attachmentPreviewAllowed(full, "a")).toBe(true);
    expect(totpActionAllowed(full, "b")).toBe(false);
  });
});
