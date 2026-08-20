import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { overlapCast } from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hb = vi.hoisted(() => ({
  state: {
    lastPushedAt: null,
    lastError: null,
    pendingCount: 0,
  },
  listeners: [],
  getBackupStatus: vi.fn(),
}));

import { backupSeams } from "../lib/backup.js";
const originalBackupSeams = { ...backupSeams };
Object.assign(backupSeams, { getBackupStatus: hb.getBackupStatus });
import { hostBackupSeams } from "../lib/vault/host-backup.js";
const originalHostBackupSeams = { ...hostBackupSeams };
Object.assign(hostBackupSeams, {
  getVaultHostBackupState: () => hb.state,
  subscribeVaultHostBackup: (listener: () => void) => {
    hb.listeners.push(listener);
    return () => {
      hb.listeners = hb.listeners.filter((l) => l !== listener);
    };
  },
});

import { BackupRecoverabilityBanner } from "./BackupRecoverabilityBanner.js";

function healthyTarget() {
  return {
    target: {
      integrationId: "int_1",
      installationId: "inst_1",
      owner: "acme",
      repo: "vault-backup",
      branch: "main",
      enabled: true,
      status: "ok",
      lastCommitSha: "abc123",
      lastSyncedAt: "2025-01-01T00:00:00Z",
      lastError: null,
    },
    pendingEvents: 0,
  };
}

describe("BackupRecoverabilityBanner", () => {
  beforeEach(() => {
    hb.state = { lastPushedAt: null, lastError: null, pendingCount: 0 };
    hb.listeners = [];
    hb.getBackupStatus.mockReset();
  });

  afterEach(cleanup);

  it("renders nothing when Host push and GitHub backup are both healthy", async () => {
    hb.getBackupStatus.mockResolvedValue(healthyTarget());
    const { container } = render(
      <MemoryRouter>
        <BackupRecoverabilityBanner />
      </MemoryRouter>,
    );
    await waitFor(() => expect(hb.getBackupStatus).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it("nags when no GitHub backup target is configured", async () => {
    hb.getBackupStatus.mockResolvedValue({ target: null, pendingEvents: 0 });
    render(
      <MemoryRouter>
        <BackupRecoverabilityBanner />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/No GitHub backup target/)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Open GitHub backup" })
        .getAttribute("href"),
    ).toBe("/settings#github-backup");
  });

  it("prefers the recorded error for a suspended target", async () => {
    const status = healthyTarget();
    status.target.status = "suspended";
    status.target.lastError = "installation revoked";
    hb.getBackupStatus.mockResolvedValue(status);
    render(
      <MemoryRouter>
        <BackupRecoverabilityBanner />
      </MemoryRouter>,
    );
    expect(await screen.findByText("installation revoked")).toBeTruthy();
  });

  it("falls back to a generic message for a suspended target", async () => {
    const status = healthyTarget();
    status.target.status = "suspended";
    hb.getBackupStatus.mockResolvedValue(status);
    render(
      <MemoryRouter>
        <BackupRecoverabilityBanner />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/GitHub backup suspended/)).toBeTruthy();
  });

  it("counts events waiting to commit", async () => {
    const status = healthyTarget();
    status.pendingEvents = 3;
    hb.getBackupStatus.mockResolvedValue(status);
    render(
      <MemoryRouter>
        <BackupRecoverabilityBanner />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText("3 backup event(s) waiting to commit to GitHub."),
    ).toBeTruthy();
  });

  it("says when the Host status cannot be read at all", async () => {
    hb.getBackupStatus.mockRejectedValue(new Error("connection refused"));
    render(
      <MemoryRouter>
        <BackupRecoverabilityBanner />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText(/Could not read GitHub backup status/),
    ).toBeTruthy();
  });

  it("surfaces Host push errors and pending vault changes immediately", async () => {
    hb.getBackupStatus.mockResolvedValue(healthyTarget());
    hb.state = {
      lastPushedAt: null,
      lastError: "Host unreachable",
      pendingCount: 2,
    };
    render(
      <MemoryRouter>
        <BackupRecoverabilityBanner />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Host unreachable")).toBeTruthy();
    expect(screen.getByText("2 vault change(s) not yet on Host.")).toBeTruthy();
  });

  it("updates when the Host backup state changes", async () => {
    hb.getBackupStatus.mockResolvedValue(healthyTarget());
    const { container } = render(
      <MemoryRouter>
        <BackupRecoverabilityBanner />
      </MemoryRouter>,
    );
    await waitFor(() => expect(hb.getBackupStatus).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();

    hb.state = { lastPushedAt: null, lastError: null, pendingCount: 1 };
    act(() => {
      for (const listener of hb.listeners) listener();
    });
    expect(
      await screen.findByText("1 vault change(s) not yet on Host."),
    ).toBeTruthy();
  });
});
