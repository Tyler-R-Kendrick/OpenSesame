/**
 * REDTEAM-D: Crash / reorder / multi-tab race probes at storage+crypto+network boundaries.
 */

import { describe, expect, it } from "vitest";
import { assertContextAllows, issueAccessContext } from "../access/context.js";
import { AlertOutbox } from "../alert/outbox.js";
import { importAlertSealingKey, sealAlertPackage } from "../alert/seal.js";
import { createIndependentCompartmentKey } from "../crypto/slots.js";
import { executeLocalRemoval } from "../removal/local-remove.js";
import { DuressSessionFence } from "../session/fence.js";
import { enrollTrigger, selectTrigger } from "../trigger/enrollment.js";
import { emptyEnrollment } from "./fixtures.js";

describe("REDTEAM-D races: fence epochs", () => {
  it("stale resolution cannot clear newer fence (AT-040)", () => {
    const fence = new DuressSessionFence("rt-race-1");
    fence.activate({
      incidentId: "i1",
      policyRevision: 1,
      keyEpoch: 1,
      denyOperations: ["export_root"],
      admittedCompartmentRefs: ["c1"],
    });
    const oldEpoch = fence.readFence().incidentEpoch;
    fence.activate({
      incidentId: "i2",
      policyRevision: 2,
      keyEpoch: 2,
      denyOperations: ["mint_grant"],
      admittedCompartmentRefs: ["c1"],
    });
    expect(fence.rejectStaleResolution(oldEpoch)).toBe(true);
    expect(fence.readFence().activeIncidentIds).toEqual(["i1", "i2"]);
    expect(fence.readFence().denyOperations).toEqual(
      expect.arrayContaining(["export_root", "mint_grant"]),
    );
  });

  it("concurrent incidents intersect compartments (never union)", () => {
    const fence = new DuressSessionFence("rt-race-2");
    fence.activate({
      incidentId: "a",
      policyRevision: 1,
      keyEpoch: 1,
      denyOperations: [],
      admittedCompartmentRefs: ["c1", "c2"],
    });
    fence.activate({
      incidentId: "b",
      policyRevision: 1,
      keyEpoch: 1,
      denyOperations: [],
      admittedCompartmentRefs: ["c2", "c3"],
    });
    expect(fence.readFence().admittedCompartmentRefs).toEqual(["c2"]);
  });

  it("unauthorized resolve fails closed", () => {
    const fence = new DuressSessionFence("rt-race-3");
    fence.activate({
      incidentId: "i1",
      policyRevision: 1,
      keyEpoch: 1,
      denyOperations: [],
      admittedCompartmentRefs: ["c1"],
    });
    expect(() => fence.resolve(["i1"], false)).toThrow(/recovery_required/);
  });

  it("stale session generation rejects protected op", () => {
    const fence = new DuressSessionFence("rt-race-4");
    fence.activate({
      incidentId: "i1",
      policyRevision: 1,
      keyEpoch: 1,
      denyOperations: [],
      admittedCompartmentRefs: ["c1"],
    });
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
      incidentEpoch: fence.readFence().incidentEpoch,
      keyEpoch: 1,
      sessionGeneration: fence.guard.generation,
      profileId: "p",
      evidenceDigest: "bbbbbbbbbbbbbbbb",
    });
    fence.guard.bump();
    expect(() =>
      assertContextAllows(ctx, "read_item", {
        policyRevision: 1,
        incidentEpoch: fence.readFence().incidentEpoch,
        keyEpoch: 1,
        sessionGeneration: fence.guard.generation,
      }),
    ).toThrow(/stale_session/);
  });
});

describe("REDTEAM-D crash: alert vs removal ordering (INV-17)", () => {
  it("outbox failure does not imply vault destruction", async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const sealing = await importAlertSealingKey(raw);
    const pkg = await sealAlertPackage({
      incidentId: "i1",
      profileId: "p",
      routeRef: "r1",
      templateRef: "t1",
      payload: { kind: "duress_alert" },
      sealingKey: sealing,
      expiryMs: 60_000,
      policyRevision: 1,
      keyEpoch: 1,
    });
    const box = new AlertOutbox();
    box.enqueue(pkg, 1);
    box.advance(pkg.packageId, "failed", "relay");
    expect(box.list()[0]?.status).toBe("failed");

    const deleted: string[] = [];
    const receipt = await executeLocalRemoval(
      {
        version: 1,
        incidentId: "i1",
        vaultRef: "v1",
        deviceBindingRef: "d1",
        resources: [
          {
            ref: "c1",
            kind: "compartment_tomb",
            storagePath: "vaults/v1/compartments/c1",
          },
        ],
        preserveSealedOutbox: true,
        acceptUnrecoverability: false,
      },
      {
        async delete(path) {
          deleted.push(path);
          return true;
        },
        async exists() {
          return true;
        },
      },
      { retainOutboxPaths: ["outbox/opaque"] },
    );
    expect(receipt.assurance).toBe("application_scoped_removal");
    expect(receipt.retainedByPolicy).toContain("outbox/opaque");
    expect(receipt.outsideControl.length).toBeGreaterThan(0);
    expect(deleted).toEqual(["vaults/v1/compartments/c1"]);
  });
});

describe("REDTEAM-D reorder: enrollment before consent / rehearsal", () => {
  it("refuses enroll without consent or rehearsal", async () => {
    const key = createIndependentCompartmentKey();
    await expect(
      enrollTrigger({
        state: emptyEnrollment({ ownerConsent: false }),
        code: "12121212",
        profileId: "p",
        triggerKind: "application_code",
        plaintext: {
          compartmentKey: key,
          actionCapability: null,
          presentation: "decoy",
        },
        autoRehearse: false,
      }),
    ).rejects.toThrow(/consent/);
    await expect(
      enrollTrigger({
        state: emptyEnrollment({ rehearsalPassed: false }),
        code: "12121212",
        profileId: "p",
        triggerKind: "application_code",
        plaintext: {
          compartmentKey: key,
          actionCapability: null,
          presentation: "decoy",
        },
        autoRehearse: false,
      }),
    ).rejects.toThrow(/rehearsal/);
  });

  it("enroll rejects colliding codes (INV-03)", async () => {
    const key = createIndependentCompartmentKey();
    let state = emptyEnrollment();
    state = await enrollTrigger({
      state,
      code: "34343434",
      profileId: "a",
      triggerKind: "application_code",
      plaintext: {
        compartmentKey: key,
        actionCapability: null,
        presentation: "decoy",
      },
    });
    await expect(
      enrollTrigger({
        state,
        code: "34343434",
        profileId: "b",
        triggerKind: "application_code",
        plaintext: {
          compartmentKey: createIndependentCompartmentKey(),
          actionCapability: null,
          presentation: "restricted",
        },
      }),
    ).rejects.toThrow(/ambiguous_trigger/);
    const hit = await selectTrigger("34343434", state);
    expect(hit.status).toBe("matched");
    if (hit.status === "matched") hit.plaintext.compartmentKey.fill(0);
  });
});
