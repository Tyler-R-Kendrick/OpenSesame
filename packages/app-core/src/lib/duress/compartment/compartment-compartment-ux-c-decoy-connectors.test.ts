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

describe("COMPARTMENT-UX-C decoy connectors", () => {
  it("defaults decoy externals off and allows only explicit safe low-authority", () => {
    expect(
      decideConnectorAttach({
        presentation: "decoy",
        connectionRef: "prod-sync",
        authorityClass: "production",
        changesProductionCredentials: false,
        approval: null,
      }),
    ).toEqual({ ok: false, code: "decoy_externals_default_off" });

    expect(
      decideConnectorAttach({
        presentation: "decoy",
        connectionRef: "prod-sync",
        authorityClass: "production",
        changesProductionCredentials: false,
        approval: approveSafeLowAuthorityConnection({
          connectionRef: "prod-sync",
        }),
      }),
    ).toEqual({ ok: false, code: "production_authority_forbidden" });

    expect(
      decideConnectorAttach({
        presentation: "decoy",
        connectionRef: "safe-rss",
        authorityClass: "low",
        changesProductionCredentials: true,
        approval: approveSafeLowAuthorityConnection({
          connectionRef: "safe-rss",
        }),
      }),
    ).toEqual({ ok: false, code: "would_mutate_production_credentials" });

    expect(
      decideConnectorAttach({
        presentation: "decoy",
        connectionRef: "safe-rss",
        authorityClass: "low",
        changesProductionCredentials: false,
        approval: approveSafeLowAuthorityConnection({
          connectionRef: "safe-rss",
        }),
        forgeProductionSuccess: true,
      }),
    ).toEqual({ ok: false, code: "unsupported_forgery" });

    expect(
      decideConnectorAttach({
        presentation: "decoy",
        connectionRef: "safe-rss",
        authorityClass: "low",
        changesProductionCredentials: false,
        approval: approveSafeLowAuthorityConnection({
          connectionRef: "safe-rss",
        }),
      }),
    ).toEqual({ ok: true, connectionRef: "safe-rss" });
  });
});
