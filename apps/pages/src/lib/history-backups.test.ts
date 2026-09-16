/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { resetHistoryBackupMemory } from "./history-backup-idb.js";
import {
  HISTORY_BACKUP_GROUPS,
  claimProvisionalHistoryAccounts,
  listHistoryAccounts,
  listHistoryEntries,
  loadHistorySelections,
  persistHistoryToPostgresAccounts,
  provisionAnonHistoryAccount,
  toggleHistoryProvider,
} from "./history-backups.js";
import { loadSettings, saveSettings } from "./settings.js";

describe("history backups", () => {
  beforeEach(() => {
    resetHistoryBackupMemory();
    const current = loadSettings();
    saveSettings({
      ...current,
      capabilityConnectors: {
        ...current.capabilityConnectors,
        history: { providerId: "github" },
      },
    });
  });

  it("groups git and postgresql providers", () => {
    expect(HISTORY_BACKUP_GROUPS.map((g) => g.id)).toEqual(["git", "postgres"]);
    expect(HISTORY_BACKUP_GROUPS[1]?.providerIds).toEqual([
      "supabase",
      "neon",
      "postgresql",
    ]);
  });

  it("provisions a real anon account and persists sealed history", async () => {
    const selections = await toggleHistoryProvider("supabase");
    const row = selections.find((s) => s.providerId === "supabase");
    expect(row?.claimState).toBe("provisional");
    expect(row?.provisionalAccountId).toBeTruthy();

    const accounts = await listHistoryAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.providerId).toBe("supabase");
    expect(accounts[0]?.anonToken.length).toBeGreaterThan(8);

    const written = await persistHistoryToPostgresAccounts(
      new TextEncoder().encode('{"rev":1,"sealed":true}'),
    );
    expect(written).toBe(1);
    const entries = await listHistoryEntries(accounts[0]?.id ?? "");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.ciphertextB64.length).toBeGreaterThan(0);
  });

  it("claims provisional accounts onto a principal", async () => {
    await toggleHistoryProvider("neon");
    await toggleHistoryProvider("postgresql");
    const claimed = await claimProvisionalHistoryAccounts("prin_test");
    expect(claimed).toBe(2);
    const accounts = await listHistoryAccounts();
    expect(accounts.every((a) => a.claimState === "claimed")).toBe(true);
    expect(accounts.every((a) => a.principalId === "prin_test")).toBe(true);
    expect(
      loadHistorySelections()
        .filter((s) => s.group === "postgres")
        .every((s) => s.claimState === "claimed"),
    ).toBe(true);
  });

  it("multi-selects git and postgres together", async () => {
    await toggleHistoryProvider("password-store");
    await toggleHistoryProvider("supabase");
    const ids = loadHistorySelections().map((s) => s.providerId);
    expect(ids).toContain("github");
    expect(ids).toContain("password-store");
    expect(ids).toContain("supabase");
  });
});

describe("provisionAnonHistoryAccount", () => {
  beforeEach(() => {
    resetHistoryBackupMemory();
  });

  it("refuses git providers", async () => {
    await expect(provisionAnonHistoryAccount("github")).rejects.toThrow(
      /anon history/,
    );
  });
});
