import { overlapCast } from "@opensesame/os-domain";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const online = vi.hoisted(() => ({ value: true }));
const session = vi.hoisted(() => ({
  current: { principalId: "prn_op" },
}));
const ensureHostSession = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const hostLocalSessionEligible = vi.hoisted(() => vi.fn(() => true));

import { useOnlineSeams } from "../../lib/use-online.js";
const originalUseOnlineSeams = { ...useOnlineSeams };
Object.assign(useOnlineSeams, { useOnline: () => online.value });
import { identitySeams } from "../../lib/identity.js";
const originalIdentitySeams = { ...identitySeams };
Object.assign(identitySeams, {
  useIdentitySession: () => session.current,
  ensureHostSession,
  hostLocalSessionEligible,
});
const listSyncTargets = vi.hoisted(() => vi.fn());
const syncTarget = vi.hoisted(() => vi.fn());
const deleteSyncTarget = vi.hoisted(() => vi.fn());

import { syncTargetSeams } from "../../lib/sync-targets.js";
const originalSyncTargetSeams = { ...syncTargetSeams };
Object.assign(syncTargetSeams, {
  listSyncTargets,
  syncTarget,
  deleteSyncTarget,
  formatSyncTargetSummary: (target: { providerId: string; status: string }) =>
    `${target.providerId} (${target.status})`,
});

import type { SyncTarget } from "../../lib/sync-targets.js";
import { SyncTargetsPanel } from "./SyncTargetsPanel.js";

function makeTarget(overrides: Partial<SyncTarget> = {}): SyncTarget {
  return {
    id: "syt_1",
    projectId: "proj_1",
    configId: "cfg_1",
    connectionId: "con_1",
    providerId: "vercel",
    operation: "env.push",
    status: "idle",
    lastSyncedAt: null,
    organizationId: "org_1",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

describe("SyncTargetsPanel", () => {
  beforeEach(() => {
    online.value = true;
    session.current = { principalId: "prn_op" };
    listSyncTargets.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("warns when offline and skips loading", () => {
    online.value = false;
    render(<SyncTargetsPanel />);
    expect(screen.getByText(/Offline — sync requires Host/i)).toBeTruthy();
    expect(listSyncTargets).not.toHaveBeenCalled();
    expect(
      overlapCast(screen.getByRole("button", { name: /Refresh/i })).disabled,
    ).toBe(true);
  });

  it("shows the empty-state hint when there are no targets", async () => {
    render(<SyncTargetsPanel />);
    expect(await screen.findByText(/No sync targets yet/i)).toBeTruthy();
    expect(ensureHostSession).toHaveBeenCalled();
  });

  it("lists targets with config metadata", async () => {
    listSyncTargets.mockResolvedValue([
      makeTarget({ lastSyncedAt: "2026-08-10T12:00:00Z" }),
    ]);
    render(<SyncTargetsPanel />);
    expect(await screen.findByText(/vercel \(idle\)/)).toBeTruthy();
    expect(screen.getByText(/cfg_1/)).toBeTruthy();
    expect(screen.getByText(/last 2026-08-10T12:00:00Z/)).toBeTruthy();
  });

  it("reports a successful sync with the key count", async () => {
    const target = makeTarget();
    listSyncTargets.mockResolvedValue([target]);
    syncTarget.mockResolvedValue({
      target: { ...target, status: "ready" },
      ok: true,
      keysSynced: 3,
    });
    render(<SyncTargetsPanel />);
    await screen.findByText(/vercel \(idle\)/);
    await userEvent.click(screen.getByRole("button", { name: /^Sync$/i }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/Synced vercel \(3 keys\)/);
    expect(syncTarget).toHaveBeenCalledWith("syt_1");
  });

  it("surfaces a failed sync outcome from the host", async () => {
    listSyncTargets.mockResolvedValue([makeTarget()]);
    syncTarget.mockResolvedValue({
      target: makeTarget({ status: "error" }),
      ok: false,
      keysSynced: 0,
      error: "connector refused",
    });
    render(<SyncTargetsPanel />);
    await screen.findByText(/vercel \(idle\)/);
    await userEvent.click(screen.getByRole("button", { name: /^Sync$/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/connector refused/);
  });

  it("falls back to a generic sync error when outcome has no detail", async () => {
    listSyncTargets.mockResolvedValue([makeTarget()]);
    syncTarget.mockResolvedValue({
      target: makeTarget(),
      ok: false,
      keysSynced: 0,
    });
    render(<SyncTargetsPanel />);
    await screen.findByText(/vercel \(idle\)/);
    await userEvent.click(screen.getByRole("button", { name: /^Sync$/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Sync failed/);
  });

  it("reports thrown sync errors", async () => {
    listSyncTargets.mockResolvedValue([makeTarget()]);
    syncTarget.mockRejectedValue(new Error("network down"));
    render(<SyncTargetsPanel />);
    await screen.findByText(/vercel \(idle\)/);
    await userEvent.click(screen.getByRole("button", { name: /^Sync$/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/network down/);
  });

  it("removes a target after delete", async () => {
    listSyncTargets.mockResolvedValue([makeTarget()]);
    deleteSyncTarget.mockResolvedValue(undefined);
    render(<SyncTargetsPanel />);
    await screen.findByText(/vercel \(idle\)/);
    await userEvent.click(screen.getByRole("button", { name: /Remove/i }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/Sync target removed/);
    expect(deleteSyncTarget).toHaveBeenCalledWith("syt_1");
    await waitFor(() =>
      expect(screen.queryByText(/vercel \(idle\)/)).toBeNull(),
    );
  });

  it("reports delete failures", async () => {
    listSyncTargets.mockResolvedValue([makeTarget()]);
    deleteSyncTarget.mockRejectedValue(new Error("forbidden"));
    render(<SyncTargetsPanel />);
    await screen.findByText(/vercel \(idle\)/);
    await userEvent.click(screen.getByRole("button", { name: /Remove/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/forbidden/);
  });

  it("surfaces load failures from listSyncTargets", async () => {
    listSyncTargets.mockRejectedValue(new Error("host unreachable"));
    render(<SyncTargetsPanel />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/host unreachable/);
  });

  it("uses a generic message for non-Error load failures", async () => {
    listSyncTargets.mockRejectedValue(42);
    render(<SyncTargetsPanel />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Could not load sync targets/);
  });

  it("reloads when Refresh is clicked", async () => {
    render(<SyncTargetsPanel />);
    await screen.findByText(/No sync targets yet/i);
    await userEvent.click(screen.getByRole("button", { name: /Refresh/i }));
    await waitFor(() => expect(listSyncTargets).toHaveBeenCalledTimes(2));
  });
});
