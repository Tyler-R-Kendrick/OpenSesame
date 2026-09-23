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

describe("COMPARTMENT-UX-A independent keys", () => {
  it("creates restricted and decoy compartments that open only with their keys", async () => {
    const restricted = await createKeyedCompartment({
      compartmentRef: "comp-restricted",
      kind: "restricted",
      label: "Everyday",
      keyEpoch: 1,
      items: [
        {
          id: "r1",
          title: "Coffee shop wifi",
          folder: "travel",
          secret: "guest",
          hasTotp: false,
        },
      ],
    });
    const decoy = await createKeyedCompartment({
      compartmentRef: "comp-decoy",
      kind: "decoy",
      label: "Decoy",
      keyEpoch: 1,
      items: [
        {
          id: "d1",
          title: "Newsletter login",
          folder: "mail",
          secret: "harmless",
          hasTotp: true,
          preview: "user@example.com",
          history: ["opened yesterday"],
          connectorRef: "safe-rss",
        },
      ],
    });

    const topology = buildTopology("vault-1", [restricted, decoy]);
    expect(() =>
      requireIndependentPresentation(topology, [
        "comp-restricted",
        "comp-decoy",
      ]),
    ).not.toThrow();

    const session = await mintPresentationSession({
      presentation: "decoy",
      profileId: "decoy",
      contextId: "sess-decoy",
      admittedKeys: [
        {
          compartmentRef: decoy.compartmentRef,
          keyEpoch: decoy.keyEpoch,
          rawKey: decoy.rawKey,
        },
      ],
    });
    const opened = await openPresentation(session, decoy, {
      expectKind: "decoy",
    });
    expect(opened.kind).toBe("opened");
    if (opened.kind === "opened") {
      expect(opened.plaintext.items[0]?.title).toBe("Newsletter login");
    }

    // Vault-root / foreign key cannot open decoy ciphertext
    const foreign = createIndependentCompartmentKey();
    expect(await tryOpenWithForeignKey(foreign, decoy)).toBeNull();
    expect(await tryOpenWithForeignKey(restricted.rawKey, decoy)).toBeNull();

    const maintained = await updateDecoyContents({
      published: decoy,
      rawKey: decoy.rawKey,
      items: [
        { id: "d2", title: "Updated decoy note", folder: "mail", secret: "x" },
      ],
    });
    const again = await openPresentation(session, maintained, {
      expectKind: "decoy",
    });
    expect(again.kind).toBe("opened");
    if (again.kind === "opened") {
      expect(again.plaintext.items.map((i) => i.id)).toEqual(["d2"]);
    }
  });
});
