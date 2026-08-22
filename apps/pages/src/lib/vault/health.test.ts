import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { buildHealthReport } from "./health.js";
import { type LoginItem, type VaultItem, createItem } from "./model.js";

function login(
  name: string,
  password: string,
  overrides: Partial<LoginItem> = {},
): LoginItem {
  const item: LoginItem = overlapCast(createItem("login", name));
  return { ...item, password, ...overrides };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

describe("password health", () => {
  it("says nothing when there are no passwords", () => {
    const report = buildHealthReport([createItem("note", "Just a note")]);
    expect(report.scored).toBe(0);
    expect(report.findings).toEqual([]);
  });

  it("flags a weak password", () => {
    const report = buildHealthReport([login("Forum", "summer2019")]);
    expect(report.counts.weak).toBe(1);
    expect(report.findings[0]?.issues).toContain("weak");
  });

  it("flags both sides of a reused password and names the other item", () => {
    const shared = "Fjord-Lantern-Cobalt-7";
    const report = buildHealthReport([
      login("Bank", shared),
      login("Shop", shared),
    ]);
    expect(report.counts.reused).toBe(2);
    const names = report.findings.flatMap((finding) => finding.sharedWith);
    expect(names).toContain("Bank");
    expect(names).toContain("Shop");
  });

  it("does not call a unique password reused", () => {
    const report = buildHealthReport([
      login("Bank", "Fjord-Lantern-Cobalt-7"),
      login("Shop", "Marina-Beacon-Trellis-4"),
    ]);
    expect(report.counts.reused).toBe(0);
  });

  it("flags a password older than a year", () => {
    const report = buildHealthReport([
      login("Old", "Fjord-Lantern-Cobalt-7", {
        passwordChangedAt: daysAgo(400),
      }),
    ]);
    expect(report.findings[0]?.issues).toContain("old");
  });

  it("does not flag a recent password as old", () => {
    const report = buildHealthReport([
      login("Fresh", "Fjord-Lantern-Cobalt-7", {
        passwordChangedAt: daysAgo(10),
      }),
    ]);
    expect(report.counts.old).toBe(0);
  });

  it("notes a missing authenticator secret", () => {
    const report = buildHealthReport([login("Bank", "Fjord-Lantern-Cobalt-7")]);
    expect(report.findings[0]?.issues).toContain("no-2fa");
  });

  it("clears a login that is strong, unique, recent, and has 2FA", () => {
    const report = buildHealthReport([
      login("Bank", "Fjord-Lantern-Cobalt-7-Quintal", {
        totp: "JBSWY3DPEHPK3PXP",
        passwordChangedAt: daysAgo(5),
      }),
    ]);
    expect(report.findings).toEqual([]);
    expect(report.clean).toBe(1);
  });

  it("ignores trashed items and non-logins", () => {
    const trashed = login("Trashed", "summer2019");
    const items: VaultItem[] = [
      { ...trashed, deletedAt: new Date().toISOString() },
      createItem("card", "Card"),
    ];
    expect(buildHealthReport(items).scored).toBe(0);
  });

  it("ignores logins with no password stored", () => {
    expect(buildHealthReport([login("Passwordless", "")]).scored).toBe(0);
  });

  it("sorts the worst offenders first", () => {
    const report = buildHealthReport([
      login("OnlyOld", "Fjord-Lantern-Cobalt-7-Quintal", {
        totp: "JBSWY3DPEHPK3PXP",
        passwordChangedAt: daysAgo(400),
      }),
      login("Terrible", "summer2019", { passwordChangedAt: daysAgo(900) }),
      login("AlsoTerrible", "summer2019", { passwordChangedAt: daysAgo(900) }),
    ]);
    expect(report.findings[0]?.item.name).toMatch(/Terrible/);
  });
});
