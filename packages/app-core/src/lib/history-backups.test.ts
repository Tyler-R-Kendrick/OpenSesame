/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { resetHistoryBackupMemory } from "./history-backup-idb.js";
import {
  HISTORY_BACKUP_GROUPS,
  isHistorySelected,
  loadHistorySelections,
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

  it("offers git remotes only", () => {
    expect(HISTORY_BACKUP_GROUPS.map((group) => group.id)).toEqual(["git"]);
    expect(HISTORY_BACKUP_GROUPS[0]?.providerIds).toEqual([
      "github",
      "password-store",
      "gitlab",
      "bitbucket",
      "codeberg",
      "origin",
      "git",
    ]);
  });

  it("refuses a provider that is not a git remote", async () => {
    await expect(toggleHistoryProvider("supabase")).rejects.toThrow(
      /unknown history provider/,
    );
  });

  it("multi-selects git remotes", async () => {
    await toggleHistoryProvider("password-store");
    await toggleHistoryProvider("gitlab");
    const ids = loadHistorySelections().map((row) => row.providerId);
    expect(ids).toEqual(["github", "password-store", "gitlab"]);
  });

  it("lets the last history remote turn off", async () => {
    expect(isHistorySelected("github")).toBe(true);
    await toggleHistoryProvider("github");
    expect(loadHistorySelections()).toEqual([]);
    expect(isHistorySelected("github")).toBe(false);
  });
});
