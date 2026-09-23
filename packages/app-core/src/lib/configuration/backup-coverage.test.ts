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
    expect(coverage.included).toEqual(["tomb/<id>/header", "tomb/<id>/body"]);
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

  it("offline backup uses the same required vault paths", () => {
    expect(offlineBackupCoverage().included).toEqual(
      sealedExportCoverage().included,
    );
    expect(
      BACKUP_COVERAGE.some((entry) => entry.kind === "not_restorable"),
    ).toBe(true);
  });
});
