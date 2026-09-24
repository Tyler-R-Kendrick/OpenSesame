import { EnrollmentManifestSchema } from "@opensesame/contracts/duress";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { kvDelete, kvGet, kvSet } from "../../kv.js";
import {
  INCIDENT_INTENT_KEY,
  activateDuressIncident,
  clearIncidentJournals,
  loadIncidentIntent,
  recoverDuressIncidentAfterRestart,
  writeIncidentIntent,
} from "../incident/index.js";
import { DuressSessionFence, duressSessionFence } from "../session/fence.js";
import { coordinateActivation } from "./activation-coordinator.js";
import { assertCompartmentSwitchAllowed } from "./compartment-guard.js";
import {
  clearCompartmentRegistry,
  emptyRegistry,
  publishCompartmentRegistry,
} from "./compartment-registry.js";
import {
  clearEnrollmentPublication,
  publishEnrollment,
  recoverEnrollmentPublication,
} from "./enrollment-publication.js";
import {
  clearJournal,
  journalSeams,
  recoverJournal,
  writeJournal,
} from "./journal.js";
import {
  canRunRootlessEffects,
  postUnlockSettingsGate,
  preUnlockDuressView,
} from "./opaque-metadata.js";
import {
  isSiblingRootCarryAttempt,
  parseEnrollmentManifest,
} from "./storage-resilience.js";

const originalDurable = journalSeams.setDurable;
const originalDurability = journalSeams.durability;

function resetFence(): void {
  const ids = [...duressSessionFence.readFence().activeIncidentIds];
  if (ids.length > 0) {
    duressSessionFence.resolve(ids, true);
  }
}

beforeEach(() => {
  journalSeams.setDurable = originalDurable;
  journalSeams.durability = originalDurability;
  clearCompartmentRegistry();
  clearEnrollmentPublication();
  clearIncidentJournals();
  resetFence();
});

describe("compartment guard (STORE-A / INV-01)", () => {
  it("allows shared-root carries when duress is off", () => {
    expect(() =>
      assertCompartmentSwitchAllowed({
        sourceTomb: "vault-a",
        targetTomb: "vault-b",
        mode: "fork",
      }),
    ).not.toThrow();
  });

  it("blocks carry outside admitted compartments when fenced", () => {
    duressSessionFence.activate({
      incidentId: "inc-store-1",
      policyRevision: 1,
      keyEpoch: 1,
      denyOperations: ["export_root"],
      admittedCompartmentRefs: ["vault-allowed"],
    });
    expect(() =>
      assertCompartmentSwitchAllowed({
        sourceTomb: "vault-allowed",
        targetTomb: "vault-forbidden",
        mode: "open",
      }),
    ).toThrow(/independent_keys_required|cannot carry/);
  });

  it("blocks sibling-root open/fork into independent compartment", async () => {
    await publishCompartmentRegistry(
      {
        vaultRef: "vault-1",
        deviceBindingRef: "device-1",
        entries: [
          {
            tomb: "personal",
            kind: "shared_root",
            profileId: null,
            admittedRootDigests: ["wrap:prod"],
          },
          {
            tomb: "decoy",
            kind: "independent",
            profileId: "decoy-profile",
            admittedRootDigests: ["wrap:decoy-only"],
          },
        ],
      },
      { requireDurable: false },
    );

    expect(() =>
      assertCompartmentSwitchAllowed({
        sourceTomb: "personal",
        targetTomb: "decoy",
        mode: "open",
        sessionRootDigest: "wrap:prod",
      }),
    ).toThrow(/shared-root cannot open independent compartment/);

    expect(() =>
      assertCompartmentSwitchAllowed({
        sourceTomb: "personal",
        targetTomb: "decoy",
        mode: "fork",
        sessionRootDigest: "wrap:prod",
      }),
    ).toThrow(/shared-root fork/);

    expect(
      isSiblingRootCarryAttempt({
        sourceIndependent: false,
        targetIndependent: true,
        sharesWrapPrediction: true,
      }),
    ).toBe(true);
  });
});

describe("journal crash recovery (STORE-C/F)", () => {
  it("recovers staged journal after write", async () => {
    const key = "duress.test.journal.v1";
    clearJournal(key);
    const written = await writeJournal(
      key,
      { incidentId: "i1", kind: "activation_intent" },
      { requireDurable: false },
    );
    expect(written.ok).toBe(true);
    const recovered = recoverJournal<{ incidentId: string }>(key);
    expect(recovered?.payload.incidentId).toBe("i1");
    clearJournal(key);
  });

  it("promotes staging after interrupted primary write", async () => {
    const key = "duress.test.interrupted";
    clearJournal(key);
    await writeJournal(key, { n: 1 }, { requireDurable: false });
    kvSet(
      `${key}.__staging`,
      JSON.stringify({
        schemaVersion: 1,
        revision: 2,
        updatedAt: new Date().toISOString(),
        payload: { n: 2 },
      }),
    );
    kvSet(`${key}.__commit`, "2");
    kvDelete(key);

    const recovered = recoverJournal<{ n: number }>(key);
    expect(recovered?.payload).toEqual({ n: 2 });
    expect(kvGet(key)).not.toBeNull();
    clearJournal(key);
  });

  it("rejects stale multi-instance revisions", async () => {
    const key = "duress.test.stale";
    clearJournal(key);
    await writeJournal(key, { a: 1 }, { requireDurable: false });
    const stale = await writeJournal(
      key,
      { a: 2 },
      { requireDurable: false, expectedRevision: 0 },
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("stale_revision");
    clearJournal(key);
  });

  it("fails closed on OPFS absence when durable required", async () => {
    journalSeams.durability = () => "memory";
    const result = await writeJournal(
      "duress.test.undurable",
      { x: 1 },
      { requireDurable: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("undurable_storage");
  });

  it("classifies quota failures when durable write refuses", async () => {
    journalSeams.durability = () => "persistent";
    journalSeams.setDurable = async () => {
      throw new Error("storage refused the write: quota");
    };
    const result = await writeJournal(
      "duress.test.quota",
      { x: 1 },
      { requireDurable: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("quota_failure");
  });

  it("rejects invalid enrollment manifests", () => {
    const bad = parseEnrollmentManifest({ schemaVersion: 1, armed: true });
    expect(bad.ok).toBe(false);
  });
});

describe("enrollment publication (STORE-B)", () => {
  it("publishes and recovers a contract-valid manifest", async () => {
    const manifest = {
      schemaVersion: 1 as const,
      vaultRef: "vault-1",
      deviceBindingRef: "device-1",
      policyId: "policy-1",
      policyRevision: 1,
      keyEpoch: 1,
      slotCount: 1,
      armed: false,
      readiness: {
        durableStorage: "verified_ready" as const,
        offlineAssets: "configured" as const,
        rehearsalPassed: true,
        ownerConsent: true,
      },
    };
    expect(EnrollmentManifestSchema.safeParse(manifest).success).toBe(true);
    const registry = emptyRegistry("vault-1", "device-1");
    const result = await publishEnrollment({
      manifest,
      registry,
      requireDurable: false,
    });
    expect(result.ok).toBe(true);
    const recovered = recoverEnrollmentPublication();
    expect(recovered?.policyId).toBe("policy-1");
  });
});

describe("opaque metadata (STORE-D)", () => {
  it("exposes pre-unlock view without protected settings", async () => {
    const written = await writeIncidentIntent(
      {
        incidentId: "i-opaque",
        profileId: "p1",
        presentation: "restricted",
        state: "active",
        policyRevision: 1,
        keyEpoch: 1,
        admittedCompartmentRefs: ["c1"],
        denyOperations: ["export_root"],
        scopeSnapshot: {
          vaultRef: "vault-1",
          deviceBindingRef: "device-1",
          compartmentRefs: ["c1"],
        },
        activationEvidenceDigest: "digest0123456789ab",
        fenceApplied: true,
      },
      { requireDurable: false },
    );
    expect(written.ok).toBe(true);
    const view = preUnlockDuressView();
    expect(view.activeIncident).toBe(true);
    expect(view.presentationHint).toBe("restricted");
    const gate = postUnlockSettingsGate(false);
    expect(gate.mayMutateEnrollment).toBe(false);
    expect(canRunRootlessEffects(loadIncidentIntent())).toBe(true);
  });
});

describe("incident activation + guest coordination (STORE-C/E)", () => {
  it("journals intent before fence and recovers after restart", async () => {
    const host = {
      activeTomb: () => "personal",
      isGuestOrEphemeral: () => false,
      isOnboarding: () => false,
      flushPendingWrites: vi.fn(async () => undefined),
      cancelPendingOps: vi.fn(),
      discardCaches: vi.fn(),
      sessionGeneration: () => 0,
    };

    const result = await activateDuressIncident(
      {
        incidentId: "inc-recover",
        profileId: "restricted",
        presentation: "restricted",
        admittedCompartmentRefs: ["restricted-comp"],
        denyOperations: ["export_root"],
        authorizationCeiling: ["read_item"],
        policyRevision: 3,
        keyEpoch: 2,
        principalRef: "owner",
        vaultRef: "vault-1",
        deviceBindingRef: "device-1",
        evidenceDigest: "evidence-digest-01",
        requireDurable: false,
      },
      { host },
    );

    expect(host.flushPendingWrites).toHaveBeenCalled();
    expect(result.intent.fenceApplied).toBe(true);
    expect(result.fence.activeIncidentIds).toContain("inc-recover");
    expect(kvGet(INCIDENT_INTENT_KEY)).not.toBeNull();

    duressSessionFence.resolve(["inc-recover"], true);
    expect(duressSessionFence.readFence().activeIncidentIds).toEqual([]);

    const recovered = recoverDuressIncidentAfterRestart();
    expect(recovered.recovered).toBe(true);
    expect(recovered.intent?.incidentId).toBe("inc-recover");
    expect(duressSessionFence.readFence().admittedCompartmentRefs).toContain(
      "restricted-comp",
    );
    expect(new DuressSessionFence("store-test-recover")).toBeTruthy();
  });

  it("skips coordination for guest sessions", async () => {
    const coordination = await coordinateActivation({
      activeTomb: () => "guest",
      isGuestOrEphemeral: () => true,
      isOnboarding: () => false,
      flushPendingWrites: async () => {
        throw new Error("must not flush guest");
      },
      cancelPendingOps: () => undefined,
      discardCaches: () => undefined,
      sessionGeneration: () => 1,
    });
    expect(coordination.skipped).toBe(true);
    expect(coordination.reason).toBe("guest");
  });
});
