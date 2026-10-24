/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { backupEgressGate } from "./backup-egress-gate.js";
import {
  clearLocalBackupTarget,
  readLocalBackupTarget,
  writeLocalBackupTarget,
} from "./backup-target-local.js";
import {
  startVaultBackupObserver,
  stopVaultBackupObserver,
} from "./vault-backup-observer.js";
import {
  drainBackupWebhooks,
  vaultBackupSyncSeams,
} from "./vault-backup-sync.js";

const original = { ...vaultBackupSyncSeams };
beforeEach(() => {
  stopVaultBackupObserver();
  clearLocalBackupTarget();
  vi.useFakeTimers();
  vi.spyOn(backupEgressGate, "running").mockReturnValue(true);
  vi.spyOn(backupEgressGate, "network").mockReturnValue({
    externalServices: "allow",
    allowedServiceOrigins: [],
  });
  writeLocalBackupTarget({
    kind: "github_app",
    providerId: "github",
    connectionId: null,
    integrationId: "",
    installationId: "77",
    owner: "fixture",
    repo: "vault",
    branch: "main",
    enabled: true,
    status: "ok",
    lastCommitSha: "a".repeat(40),
    lastSyncedAt: "2026-10-23T12:00:00.000Z",
    lastError: null,
    config: null,
    pendingEvents: 3,
  });
});
afterEach(() => {
  stopVaultBackupObserver();
  clearLocalBackupTarget();
  Object.assign(vaultBackupSyncSeams, original);
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("observes initial and interval drain rejection without changing previous success or clearing pending work", async () => {
  const failure = new Error("No current App credential");
  const drain = vi
    .spyOn(vaultBackupSyncSeams, "drainWebhookPending")
    .mockRejectedValue(failure);
  const push = vi.spyOn(vaultBackupSyncSeams, "putContents");
  const previous = readLocalBackupTarget("github");
  const stop = startVaultBackupObserver();
  await vi.advanceTimersByTimeAsync(0);
  expect(drain).toHaveBeenCalledTimes(1);
  expect(readLocalBackupTarget("github")).toEqual(previous);
  await vi.advanceTimersByTimeAsync(30000);
  expect(drain).toHaveBeenCalledTimes(2);
  expect(push).not.toHaveBeenCalled();
  expect(readLocalBackupTarget("github")).toEqual(previous);
  stop();
  await vi.advanceTimersByTimeAsync(30000);
  expect(drain).toHaveBeenCalledTimes(2);
});
it("leaves explicit manual drain failure rejectable", async () => {
  const failure = new Error("Provider rejected branch polling");
  vi.spyOn(vaultBackupSyncSeams, "drainWebhookPending").mockRejectedValue(
    failure,
  );
  const previous = readLocalBackupTarget("github");
  await expect(drainBackupWebhooks()).rejects.toBe(failure);
  expect(readLocalBackupTarget("github")).toEqual(previous);
});
it("continues the normal poll schedule after a refusal without inventing a write", async () => {
  const drain = vi
    .spyOn(vaultBackupSyncSeams, "drainWebhookPending")
    .mockRejectedValueOnce(new Error("temporary refusal"))
    .mockResolvedValue(0);
  const push = vi.spyOn(vaultBackupSyncSeams, "putContents");
  const previous = readLocalBackupTarget("github");
  startVaultBackupObserver();
  await vi.advanceTimersByTimeAsync(30000);
  expect(drain).toHaveBeenCalledTimes(2);
  expect(push).not.toHaveBeenCalled();
  expect(readLocalBackupTarget("github")).toEqual(previous);
});
