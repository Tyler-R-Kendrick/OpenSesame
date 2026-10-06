import {
  type AccountItem,
  type VaultItem,
  createItem,
  manualPassword,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { pepperedAccount } from "../account.test-support.js";
import { buildHealthReport } from "./health.js";

type Overrides = { totp?: string; passwordChangedAt?: string };

function login(
  name: string,
  password: string,
  overrides: Overrides = {},
): AccountItem {
  const item = createItem("account", name);
  item.methods = [
    manualPassword(
      `${item.id}:password`,
      password,
      overrides.passwordChangedAt ?? item.createdAt,
    ),
  ];
  if (overrides.totp !== undefined) {
    item.methods.push({
      id: `${item.id}:authenticator`,
      type: "authenticator",
      secret: overrides.totp,
    });
  }
  return item;
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

  it("clears an account that is strong, unique, recent, and has 2FA", () => {
    const report = buildHealthReport([
      login("Bank", "Fjord-Lantern-Cobalt-7-Quintal", {
        totp: "JBSWY3DPEHPK3PXP",
        passwordChangedAt: daysAgo(5),
      }),
    ]);
    expect(report.findings).toEqual([]);
    expect(report.clean).toBe(1);
  });

  it("ignores trashed items and non-accounts", () => {
    const trashed = login("Trashed", "summer2019");
    const items: VaultItem[] = [
      { ...trashed, deletedAt: new Date().toISOString() },
      createItem("card", "Card"),
    ];
    expect(buildHealthReport(items).scored).toBe(0);
  });

  it("ignores accounts with no password stored", () => {
    expect(buildHealthReport([login("Passwordless", "")]).scored).toBe(0);
  });

  it("skips a peppered password and counts it as unchecked", async () => {
    const peppered = await pepperedAccount("Vaulted", "summer2019", "pepper");
    const report = buildHealthReport([peppered, login("Plain", "summer2019")]);
    // The peppered duplicate is neither read nor compared: no reuse, no weak.
    expect(report.scored).toBe(1);
    expect(report.unchecked).toBe(1);
    expect(report.counts.reused).toBe(0);
    expect(report.findings.map((finding) => finding.item.name)).toEqual([
      "Plain",
    ]);
  });

  it("skips a Sphinx password too", () => {
    const sphinx = createItem("account", "Sphinxed");
    sphinx.methods = [
      {
        id: `${sphinx.id}:password`,
        type: "password",
        generator: {
          id: "sphinx",
          rules: {
            length: 20,
            lower: true,
            upper: true,
            digits: true,
            symbols: false,
            avoidAmbiguous: false,
            minDigits: 0,
            minSymbols: 0,
          },
          realm: "example.com",
          counter: 0,
          oprfKeyB64: "AAAA",
        },
        pepper: true,
        secret: "",
        changedAt: sphinx.createdAt,
      },
    ];
    const report = buildHealthReport([sphinx]);
    expect(report.scored).toBe(0);
    expect(report.unchecked).toBe(1);
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
