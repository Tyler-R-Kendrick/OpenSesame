/**
 * REDTEAM-B: Bypass attempts against live duress modules.
 * Failures are intentional findings — do not force-pass.
 */

import { describe, expect, it } from "vitest";
import {
  assertContextAllows,
  isAccessContext,
  issueAccessContext,
  publicAccessMetadata,
} from "../access/context.js";
import { parseCanaryActivation } from "../canary/detect.js";
import {
  DURESS_PIN_PBKDF2_ITERATIONS,
  createIndependentCompartmentKey,
  openPrfAndCode,
  openProfileSlot,
  sealPrfAndCode,
  sealProfileSlot,
} from "../crypto/slots.js";
import { defined } from "../defined.js";
import { overlapCast } from "../json-boundary.js";
import {
  combineRecoveryShares,
  roleAllows,
  splitRecoverySecret,
} from "../recovery/custody.js";
import {
  assertOwnedPath,
  isUnsupportedDestructiveAction,
} from "../removal/local-remove.js";
import { duressSessionFence } from "../session/fence.js";
import { assertCompartmentSwitchAllowed } from "../store/compartment-guard.js";
import { enrollTrigger, selectTrigger } from "../trigger/enrollment.js";
import { emptyEnrollment } from "./fixtures.js";

describe("REDTEAM-B bypass: access context forgery", () => {
  it("rejects deserialized / Symbol-injected copies (AT-032)", () => {
    const ctx = issueAccessContext({
      principalRef: "p1",
      tenantRef: null,
      vaultRef: "v1",
      compartmentRefs: ["c1"],
      deviceBindingRef: "d1",
      presentation: "restricted",
      authorizationCeiling: ["read_item"],
      denyOperations: [],
      policyRevision: 1,
      incidentEpoch: 1,
      keyEpoch: 1,
      sessionGeneration: 1,
      profileId: "p",
      evidenceDigest: "aaaaaaaaaaaaaaaa",
    });
    const forged = {
      ...publicAccessMetadata(ctx),
      claims: {
        ...ctx.claims,
        presentation: "normal",
        authorizationCeiling: ["export_root", "administer_access"],
      },
    };
    expect(
      isAccessContext(
        overlapCast<
          typeof forged,
          import("../access/context.js").AccessContextProbe
        >(forged),
      ),
    ).toBe(false);
    expect(() =>
      assertContextAllows(
        overlapCast<
          typeof forged,
          import("../access/context.js").AccessContext
        >(forged),
        "export_root",
        {
          policyRevision: 1,
          incidentEpoch: 1,
          keyEpoch: 1,
          sessionGeneration: 1,
        },
      ),
    ).toThrow(/forged|stale_session/);
  });
});

describe("REDTEAM-B bypass: PRF / UV / alternate wrappers", () => {
  it("PRF alone and code alone never open two-input envelope (AT-020..022)", async () => {
    const key = createIndependentCompartmentKey();
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const env = await sealPrfAndCode({
      prfOutput: prf,
      code: "11223344",
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
        code: "11223344",
        envelope: env,
      }),
    ).toBeNull();
    expect(
      await openPrfAndCode({
        prfOutput: crypto.getRandomValues(new Uint8Array(32)),
        code: "11223344",
        envelope: env,
      }),
    ).toBeNull();
  });

  it("rejects KDF iterations below vault PIN floor on seal", async () => {
    const key = createIndependentCompartmentKey();
    await expect(
      sealProfileSlot({
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
        iterations: DURESS_PIN_PBKDF2_ITERATIONS - 1,
      }),
    ).rejects.toThrow(/iterations/);
  });

  it("verified_uv_then_code requires UV bit AND complete code (INV-08)", async () => {
    const state = emptyEnrollment({
      capabilities: {
        durableLocalStorage: true,
        prfAvailable: false,
        userVerificationAvailable: true,
        offlineReady: true,
      },
    });
    const key = createIndependentCompartmentKey();
    const enrolled = await enrollTrigger({
      state,
      code: "99887766",
      profileId: "uv-code",
      triggerKind: "verified_uv_then_code",
      plaintext: {
        compartmentKey: key,
        actionCapability: null,
        presentation: "restricted",
      },
    });
    expect(await selectTrigger("9988776", enrolled)).toEqual({
      status: "none",
    });
    // UV alone / UV missing with full code → none
    expect(
      await selectTrigger("99887766", enrolled, { userVerified: false }),
    ).toEqual({ status: "none" });
    expect(await selectTrigger("99887766", enrolled)).toEqual({
      status: "none",
    });
    const hit = await selectTrigger("99887766", enrolled, {
      userVerified: true,
    });
    expect(hit.status).toBe("matched");
    if (hit.status === "matched") {
      expect(hit.triggerKind).toBe("verified_uv_then_code");
      hit.plaintext.compartmentKey.fill(0);
    }
  });
});

describe("REDTEAM-B bypass: legacy wrappers / shared-root / VFS", () => {
  it("refuses compartment switch outside admitted set while fenced", () => {
    duressSessionFence.activate({
      incidentId: `rt-switch-${Date.now()}`,
      policyRevision: 1,
      keyEpoch: 1,
      denyOperations: ["export_root"],
      admittedCompartmentRefs: ["comp-decoy"],
    });
    expect(() => assertCompartmentSwitchAllowed("shared-root-fork")).toThrow(
      /independent_keys_required/,
    );
    expect(() => assertCompartmentSwitchAllowed("comp-decoy")).not.toThrow();
  });

  it("scoped decoy view never exposes protected titles", async () => {
    const {
      createKeyedCompartment,
      mintPresentationSession,
      openPresentation,
      projectScopedView,
      assertNoProtectedLeak,
    } = await import("../compartment/project.js");
    const decoy = await createKeyedCompartment({
      compartmentRef: "comp-decoy",
      kind: "decoy",
      label: "decoy",
      items: [{ id: "2", title: "decoy-item" }],
      keyEpoch: 1,
    });
    const protectedComp = await createKeyedCompartment({
      compartmentRef: "comp-normal",
      kind: "restricted",
      label: "prod",
      items: [{ id: "1", title: "PROTECTED-TITLE-DO-NOT-LEAK" }],
      keyEpoch: 1,
    });
    const session = await mintPresentationSession({
      presentation: "decoy",
      profileId: "p",
      contextId: "rt-ctx",
      admittedKeys: [
        {
          compartmentRef: "comp-decoy",
          keyEpoch: 1,
          rawKey: decoy.rawKey,
        },
      ],
    });
    const opened = await openPresentation(session, decoy, {
      expectKind: "decoy",
    });
    expect(opened.kind).toBe("opened");
    const view = projectScopedView(opened);
    assertNoProtectedLeak(view, ["PROTECTED-TITLE-DO-NOT-LEAK"]);
    const foreign = await openPresentation(session, protectedComp);
    expect(foreign.kind).toBe("locked");
  });
});

describe("REDTEAM-B bypass: removal path traversal (AT-076)", () => {
  it("rejects literal and lowercase-encoded traversal", () => {
    expect(() => assertOwnedPath("vaults/v1/../etc/passwd", "v1")).toThrow();
    expect(() =>
      assertOwnedPath("vaults/v1/compartments/%2e%2e/secret", "v1"),
    ).toThrow();
  });

  it("MUST reject uppercase-encoded traversal %2E%2E (finding RT-BACKUP-001)", () => {
    expect(() =>
      assertOwnedPath("vaults/v1/compartments/%2E%2E/secret", "v1"),
    ).toThrow(/scope_mismatch|path traversal/);
  });

  it("labels unsupported destructive actions honestly", () => {
    expect(isUnsupportedDestructiveAction("device_brick")).toBe(true);
    expect(isUnsupportedDestructiveAction("shell_exec")).toBe(true);
    expect(isUnsupportedDestructiveAction("local_enumerated")).toBe(false);
  });
});

describe("REDTEAM-B bypass: canary injection / auto-trigger", () => {
  it("rejects top-level destructive canary fields", () => {
    expect(() =>
      parseCanaryActivation({
        version: 1,
        canaryId: "c",
        routeRef: "r",
        wipe: true,
      }),
    ).toThrow(/destructive|contradictory/);
  });

  it("MUST reject nested destructive payloads at parse (finding RT-CANARY-001)", () => {
    // Executor recurses; schema parseCanaryActivation currently only checks top-level keys.
    expect(() =>
      parseCanaryActivation({
        version: 1,
        canaryId: "canary-nested-1",
        routeRef: "route-1",
        effects: { wipe: true, mintSession: true },
      }),
    ).toThrow(/destructive|contradictory/);
  });
});
