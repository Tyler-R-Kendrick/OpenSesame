import { describe, expect, it } from "vitest";
import { retireDeviceBinding } from "../removal/device-retirement.js";
import {
  type OfflineSnapshot,
  discloseResidualDecryptability,
  refuseMaliciousEpochDowngrade,
  validateBackupImport,
} from "./import-guard.js";
import { evaluateRestoreBoundary } from "./restore-boundary.js";

const current = {
  incidentEpoch: 3,
  policyRevision: 5,
  keyEpoch: 7,
};

function snap(
  overrides: Omit<Partial<OfflineSnapshot>, "epochs"> & {
    epochs?: Partial<OfflineSnapshot["epochs"]>;
  } = {},
): OfflineSnapshot {
  const { epochs: epochOverrides, ...rest } = overrides;
  return {
    version: 1,
    vaultRef: "v1",
    deviceBindingRef: "d1",
    capturedAt: "2026-09-01T00:00:00.000Z",
    embedsUsableOldRoot: true,
    ciphertextPresent: true,
    ...rest,
    epochs: {
      incidentEpoch: 3,
      policyRevision: 5,
      keyEpoch: 7,
      ...epochOverrides,
    },
  };
}

describe("BACKUP-D backup import epochs + residual disclosure", () => {
  it("discloses old offline snapshot residual decryptability", () => {
    const residual = discloseResidualDecryptability({
      embedsUsableOldRoot: true,
      ciphertextPresent: true,
    });
    expect(residual.historicalCopyMayDecrypt).toBe(true);
    expect(residual.disclosure).toBe(
      "old_offline_snapshot_plus_old_key_remains_decryptable",
    );
    expect(residual.rootRotationIsRetroactiveSecrecy).toBe(false);
  });

  it("rejects stale policy/key/incident epochs while disclosing residual", () => {
    const stalePolicy = validateBackupImport({
      snapshot: snap({ epochs: { policyRevision: 4 } }),
      current,
      deviceRetired: false,
    });
    expect(stalePolicy).toMatchObject({
      allowed: false,
      code: "stale_policy",
    });
    if (!stalePolicy.allowed) {
      expect(stalePolicy.residualDecryptability.historicalCopyMayDecrypt).toBe(
        true,
      );
    }

    const staleKey = validateBackupImport({
      snapshot: snap({ epochs: { keyEpoch: 6 } }),
      current,
      deviceRetired: false,
    });
    expect(staleKey).toMatchObject({ allowed: false, code: "stale_session" });

    const staleIncident = validateBackupImport({
      snapshot: snap({ epochs: { incidentEpoch: 1 } }),
      current,
      deviceRetired: false,
    });
    expect(staleIncident).toMatchObject({
      allowed: false,
      code: "stale_session",
    });
  });

  it("accepts matching epochs and still discloses residual risk", () => {
    const ok = validateBackupImport({
      snapshot: snap(),
      current,
      deviceRetired: false,
    });
    expect(ok.allowed).toBe(true);
    if (ok.allowed) {
      expect(ok.residualDecryptability.historicalCopyMayDecrypt).toBe(true);
    }
  });

  it("refuses import onto retired device without recovery", () => {
    const denied = validateBackupImport({
      snapshot: snap(),
      current,
      deviceRetired: true,
      recoveryAuthorized: false,
    });
    expect(denied).toMatchObject({ allowed: false, code: "retired_device" });

    const allowed = validateBackupImport({
      snapshot: snap(),
      current,
      deviceRetired: true,
      recoveryAuthorized: true,
    });
    expect(allowed.allowed).toBe(true);
  });
});

describe("BACKUP-C/F restore boundary + malicious restore", () => {
  it("blocks automatic backup import on retired binding", () => {
    const retirement = retireDeviceBinding({
      deviceBindingRef: "d1",
      vaultRef: "v1",
      incidentId: "i1",
    });
    const result = evaluateRestoreBoundary({
      retirement,
      attempt: {
        kind: "backup_import",
        deviceBindingRef: "d1",
        source: "offline_snapshot",
      },
      snapshot: snap({ epochs: { keyEpoch: 1 } }),
      currentEpochs: current,
    });
    expect(result.restore.allowed).toBe(false);
  });

  it("refuses malicious epoch downgrade from snapshot alone", () => {
    const refused = refuseMaliciousEpochDowngrade({
      proposed: { incidentEpoch: 0, policyRevision: 1, keyEpoch: 1 },
      current,
    });
    expect(refused).toEqual({
      ok: false,
      code: "stale_session",
      current,
    });
  });

  it("after recovery authorization, still validates epochs", () => {
    const retirement = retireDeviceBinding({
      deviceBindingRef: "d1",
      vaultRef: "v1",
      incidentId: "i1",
    });
    const result = evaluateRestoreBoundary({
      retirement,
      attempt: {
        kind: "recovery_ceremony",
        deviceBindingRef: "d1",
        source: "authorized_recovery",
      },
      snapshot: snap({ epochs: { policyRevision: 1 } }),
      currentEpochs: current,
      recoveryAuthorized: true,
    });
    expect(result.restore.allowed).toBe(true);
    // recovery_ceremony path does not auto-run importGate unless backup_import
    expect(result.importGate).toBeNull();
  });
});
