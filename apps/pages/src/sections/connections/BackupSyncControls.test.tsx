import { backupSeams } from "@opensesame/app-core/lib/backup.js";
/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupSyncControls } from "./BackupSyncControls.js";

const original = { ...backupSeams };

afterEach(() => {
  cleanup();
  Object.assign(backupSeams, original);
});

beforeEach(() => {
  Object.assign(backupSeams, {
    getBackupStatus: vi.fn(async () => ({
      target: {
        kind: "github_app",
        providerId: null,
        connectionId: "conn_1",
        integrationId: "int_1",
        installationId: "99",
        owner: "acme",
        repo: "vault",
        branch: "main",
        enabled: true,
        status: "ok",
        lastCommitSha: "abc",
        lastSyncedAt: "2026-09-20T12:00:00.000Z",
        lastError: null,
        config: null,
      },
      pendingEvents: 2,
    })),
    resyncBackup: vi.fn(async () => undefined),
    setBackupTargetEnabled: vi.fn(async (enabled: boolean) => ({
      kind: "github_app",
      providerId: null,
      connectionId: "conn_1",
      integrationId: "int_1",
      installationId: "99",
      owner: "acme",
      repo: "vault",
      branch: "main",
      enabled,
      status: "ok",
      lastCommitSha: "abc",
      lastSyncedAt: "2026-09-20T12:00:00.000Z",
      lastError: null,
      config: null,
    })),
  });
});

describe("BackupSyncControls", () => {
  it("runs a manual sync when the backup target is enabled", async () => {
    render(<BackupSyncControls providerId="github" />);
    const sync = await waitFor(() =>
      screen.getByRole("button", { name: "Sync vault backup now" }),
    );
    expect(screen.getByText("acme/vault")).toBeTruthy();
    fireEvent.click(sync);
    await waitFor(() => expect(backupSeams.resyncBackup).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Synced" })).toBeTruthy(),
    );
  });

  it("surfaces the last sync error on the status mark", async () => {
    Object.assign(backupSeams, {
      getBackupStatus: vi.fn(async () => ({
        target: {
          kind: "github_app",
          providerId: "github",
          connectionId: null,
          integrationId: "int_1",
          installationId: "99",
          owner: "acme",
          repo: "vault",
          branch: "main",
          enabled: true,
          status: "error",
          lastCommitSha: null,
          lastSyncedAt: null,
          lastError: "GitHub App signing key is not available on this device.",
          config: null,
        },
        pendingEvents: 1,
      })),
    });
    render(<BackupSyncControls providerId="github" />);
    await waitFor(() =>
      expect(
        screen.getByRole("img", {
          name: "GitHub App signing key is not available on this device.",
        }),
      ).toBeTruthy(),
    );
  });
});
