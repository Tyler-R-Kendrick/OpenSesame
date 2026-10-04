import { describe, expect, it } from "vitest";
import {
  BACKUP_COVERAGE,
  inventoryBackup,
  offlineBackupCoverage,
  sealedExportCoverage,
} from "./backup-coverage.js";

describe("backup coverage", () => {
  it("sealed export includes header and body and omits prefs source", () => {
    const coverage = sealedExportCoverage();
    expect(coverage.format).toBe("opensesame-vault-export");
    expect(coverage.included).toEqual([
      "tomb/<id>/header",
      "tomb/<id>/body",
      "config/device-identity-key",
    ]);
    expect(coverage.complete).toBe(true);
    expect(coverage.omitted).toContain("config/prefs.source.yaml");
    expect(coverage.omitted).toContain("sessions/grants");
  });

  it("cannot claim completeness while omitting the vault body", () => {
    const incomplete = inventoryBackup({
      format: "opensesame-vault-export",
      paths: ["tomb/<id>/header"],
    });
    expect(incomplete.complete).toBe(false);
    expect(incomplete.omitted).toContain("tomb/<id>/body");
  });

  it("carries the device identity key in both formats, so a restore keeps the principal", () => {
    for (const coverage of [sealedExportCoverage(), offlineBackupCoverage()]) {
      expect(coverage.included).toContain("config/device-identity-key");
      expect(coverage.omitted).not.toContain("config/device-identity-key");
    }
    // A backup that cannot show the key is not complete, even with a body.
    const without = inventoryBackup({
      format: "opensesame-offline-backup",
      paths: ["tomb/<id>/header", "tomb/<id>/body"],
    });
    expect(without.complete).toBe(false);
    expect(without.omitted).toContain("config/device-identity-key");
  });

  it("offline backup uses the same required vault paths", () => {
    expect(offlineBackupCoverage().included).toEqual(
      sealedExportCoverage().included,
    );
    expect(
      BACKUP_COVERAGE.some((entry) => entry.kind === "not_restorable"),
    ).toBe(true);
  });
});
