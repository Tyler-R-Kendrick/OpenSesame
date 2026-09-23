import { describe, expect, it } from "vitest";
import {
  clearDeviceRetirement,
  decideRestoreAttempt,
  retireDeviceBinding,
} from "./device-retirement.js";
import {
  MemoryStorageInventory,
  assertOwnedPath,
  buildRemovalManifest,
} from "./inventory.js";
import {
  createDeviceRetirementEvent,
  executeLocalRemoval,
  isUnsupportedDestructiveAction,
  leftoverInScope,
  refuseUnsupportedDestructiveAction,
  resumeLocalRemoval,
  retirementImpliesContentPurge,
} from "./local-remove.js";
import {
  type ProviderRevocationAdapter,
  assertHonestAdapter,
  localRemovalImpliesProviderRevoke,
  revokeProviders,
} from "./provider-revocation.js";

describe("BACKUP-A inventory manifests", () => {
  it("intersects approved refs with live inventory only", async () => {
    const inv = new MemoryStorageInventory([
      {
        ref: "c1",
        kind: "compartment_tomb",
        storagePath: "vaults/v1/compartments/c1",
        designatedRecovery: false,
        sealedOutbox: false,
      },
      {
        ref: "c2",
        kind: "wrapper_record",
        storagePath: "vaults/v1/wrappers/c2",
        designatedRecovery: false,
        sealedOutbox: false,
      },
      {
        ref: "out1",
        kind: "sealed_outbox",
        storagePath: "vaults/v1/grants/out1",
        designatedRecovery: false,
        sealedOutbox: true,
      },
      {
        ref: "rec1",
        kind: "recovery_copy",
        storagePath: "vaults/v1/compartments/rec1",
        designatedRecovery: true,
        sealedOutbox: false,
      },
    ]);
    const listed = await inv.list("v1");
    const { manifest, skippedOutsideInventory, preservedRecovery } =
      buildRemovalManifest({
        incidentId: "i1",
        vaultRef: "v1",
        deviceBindingRef: "d1",
        approvedResourceRefs: ["c1", "out1", "rec1", "ghost"],
        inventory: listed,
        preserveSealedOutbox: true,
        acceptUnrecoverability: false,
      });
    expect(manifest.resources.map((r) => r.ref)).toEqual(["c1"]);
    expect(skippedOutsideInventory).toEqual(["ghost"]);
    expect(preservedRecovery).toEqual(["rec1"]);
  });

  it("rejects path traversal and unapproved classes", () => {
    expect(() => assertOwnedPath("vaults/v1/../etc/passwd", "v1")).toThrow(
      /scope_mismatch/,
    );
    expect(() => assertOwnedPath("vaults/other/compartments/c1", "v1")).toThrow(
      /outside vault/,
    );
    expect(() => assertOwnedPath("vaults/v1/secrets/x", "v1")).toThrow(
      /unapproved/,
    );
  });
});

describe("BACKUP-B device retirement vs content deletion", () => {
  it("emits local-only control-plane event, not replicated tombstone", () => {
    const event = createDeviceRetirementEvent({
      deviceBindingRef: "d1",
      vaultRef: "v1",
      incidentId: "i1",
    });
    expect(event.replicationClass).toBe("local_only_control_plane");
    expect(event.doesNotMean).toContain("replicated_item_tombstone");
    expect(retirementImpliesContentPurge(event)).toBe(false);
  });

  it("preserves designated recovery copies during removal", async () => {
    const inv = new MemoryStorageInventory([
      {
        ref: "c1",
        kind: "compartment_tomb",
        storagePath: "vaults/v1/compartments/c1",
        designatedRecovery: false,
        sealedOutbox: false,
      },
      {
        ref: "rec1",
        kind: "recovery_copy",
        storagePath: "vaults/v1/compartments/rec1",
        designatedRecovery: true,
        sealedOutbox: false,
      },
    ]);
    const listed = await inv.list("v1");
    const { manifest, preservedRecovery } = buildRemovalManifest({
      incidentId: "i1",
      vaultRef: "v1",
      deviceBindingRef: "d1",
      approvedResourceRefs: ["c1", "rec1"],
      inventory: listed,
      preserveSealedOutbox: false,
      acceptUnrecoverability: true,
    });
    expect(preservedRecovery).toEqual(["rec1"]);
    const receipt = await executeLocalRemoval(manifest, inv, {
      preserveRecoveryPaths: ["vaults/v1/compartments/rec1"],
      retireDevice: true,
    });
    expect(receipt.removed).toEqual(["c1"]);
    expect(await inv.exists("vaults/v1/compartments/rec1")).toBe(true);
    expect(receipt.assurance).toBe("application_scoped_removal");
    expect(receipt.deviceRetired).toBe(true);
  });

  it("refuses origin wipe / device brick / whole-disk wipe", () => {
    for (const action of [
      "device_brick",
      "origin_wipe",
      "whole_disk_wipe",
      "forensic_erase",
    ] as const) {
      expect(isUnsupportedDestructiveAction(action)).toBe(true);
      expect(refuseUnsupportedDestructiveAction(action)).toEqual({
        ok: false,
        code: "unsupported_action",
        action,
      });
    }
  });
});

describe("BACKUP-C no auto restore to retired device", () => {
  it("blocks sync/login restore; allows recovery/reenroll", () => {
    const retired = retireDeviceBinding({
      deviceBindingRef: "d1",
      vaultRef: "v1",
      incidentId: "i1",
    });
    expect(retired.autoRestoreAllowed).toBe(false);
    expect(
      decideRestoreAttempt(retired, {
        kind: "sync_pull",
        deviceBindingRef: "d1",
        source: "cloud_sync",
      }).allowed,
    ).toBe(false);
    expect(
      decideRestoreAttempt(retired, {
        kind: "login_restore",
        deviceBindingRef: "d1",
        source: "session_resume",
      }),
    ).toMatchObject({ allowed: false, code: "retired_device" });
    expect(
      decideRestoreAttempt(retired, {
        kind: "recovery_ceremony",
        deviceBindingRef: "d1",
        source: "authorized_recovery",
      }).allowed,
    ).toBe(true);
    expect(
      clearDeviceRetirement(retired, {
        kind: "reenroll",
        authorized: true,
      }),
    ).toBeNull();
    expect(() =>
      clearDeviceRetirement(retired, {
        kind: "reenroll",
        authorized: false,
      }),
    ).toThrow(/recovery_required/);
  });
});

describe("BACKUP-E provider revocation honesty", () => {
  it("marks missing adapters unsupported; never stubs success", async () => {
    const real: ProviderRevocationAdapter = {
      providerRef: "prov-ok",
      async revoke() {
        return "ok";
      },
    };
    const receipts = await revokeProviders({
      providerRefs: ["prov-ok", "prov-missing"],
      adapters: [real],
      vaultRef: "v1",
      deviceBindingRef: "d1",
      incidentId: "i1",
    });
    expect(receipts).toEqual([
      {
        providerRef: "prov-ok",
        outcome: "ok",
        residualDisclosure: "derivative_sessions_may_remain",
      },
      {
        providerRef: "prov-missing",
        outcome: "unsupported",
        residualDisclosure: "derivative_sessions_may_remain",
        detail: "No real revocation adapter registered for this provider.",
      },
    ]);
    expect(localRemovalImpliesProviderRevoke()).toBe(false);
    expect(() =>
      assertHonestAdapter({
        providerRef: "stub",
        __stubSuccess: true,
        async revoke() {
          return "ok";
        },
      }),
    ).toThrow(/stub/);
  });
});

describe("BACKUP-F cleanup resume, outbox, partial deletion", () => {
  it("retains sealed outbox and resumes after partial failure", async () => {
    const inv = new MemoryStorageInventory([
      {
        ref: "c1",
        kind: "compartment_tomb",
        storagePath: "vaults/v1/compartments/c1",
        designatedRecovery: false,
        sealedOutbox: false,
      },
      {
        ref: "c2",
        kind: "wrapper_record",
        storagePath: "vaults/v1/wrappers/c2",
        designatedRecovery: false,
        sealedOutbox: false,
      },
      {
        ref: "out1",
        kind: "grant_handle",
        storagePath: "vaults/v1/grants/out1",
        designatedRecovery: false,
        sealedOutbox: true,
      },
    ]);
    const listed = await inv.list("v1");
    const { manifest } = buildRemovalManifest({
      incidentId: "i1",
      vaultRef: "v1",
      deviceBindingRef: "d1",
      approvedResourceRefs: ["c1", "c2", "out1"],
      inventory: listed,
      preserveSealedOutbox: true,
      acceptUnrecoverability: true,
    });

    let failOnce = true;
    const flaky = {
      async delete(path: string) {
        if (failOnce && path.endsWith("/c2")) {
          failOnce = false;
          return false;
        }
        return inv.delete(path);
      },
      exists: (path: string) => inv.exists(path),
    };

    const partial = await executeLocalRemoval(manifest, flaky, {
      retainOutboxPaths: ["vaults/v1/grants/out1"],
    });
    expect(partial.completion).toBe("completion_unknown");
    expect(partial.failed).toContain("c2");
    expect(partial.retainedByPolicy).toContain("vaults/v1/grants/out1");
    expect(await inv.exists("vaults/v1/grants/out1")).toBe(true);

    const resumed = await resumeLocalRemoval(manifest, inv, partial, {
      retainOutboxPaths: ["vaults/v1/grants/out1"],
    });
    expect(resumed.removed).toContain("c2");
    expect(resumed.pendingPaths).toEqual([]);
    expect(leftoverInScope(await inv.list("v1"), manifest, resumed)).toEqual(
      [],
    );
  });
});
