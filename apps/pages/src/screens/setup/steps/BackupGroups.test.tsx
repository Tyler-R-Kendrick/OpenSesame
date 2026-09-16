/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetHistoryBackupMemory } from "../../../lib/history-backup-idb.js";
import { loadHistorySelections } from "../../../lib/history-backups.js";
import { loadSettings, saveSettings } from "../../../lib/settings.js";
import { BackupGroups } from "./BackupGroups.js";

describe("BackupGroups", () => {
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

  afterEach(() => {
    cleanup();
  });

  it("renders git and postgresql groups as multi-select", async () => {
    render(<BackupGroups />);
    expect(screen.getByRole("heading", { name: "Git" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "PostgreSQL" })).toBeTruthy();
    expect(screen.getByText("Supabase")).toBeTruthy();
    expect(screen.getByText("Neon")).toBeTruthy();
    expect(screen.getAllByText("PostgreSQL").length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: /Supabase/i }));
    await waitFor(() => {
      const row = loadHistorySelections().find(
        (s) => s.providerId === "supabase",
      );
      expect(row?.claimState).toBe("provisional");
      expect(row?.provisionalAccountId).toBeTruthy();
      expect(screen.getByText("Claimable")).toBeTruthy();
    });
  });
});
