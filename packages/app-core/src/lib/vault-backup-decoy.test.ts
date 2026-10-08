import { afterEach, expect, it, vi } from "vitest";
import { backupEgressGate } from "./backup-egress-gate.js";
import {
  isDecoySession,
  markDecoySession,
  requiresFreshOwnerAuthentication,
} from "./decoy-session.js";
import {
  startVaultBackupObserver,
  stopVaultBackupObserver,
  subscribeBackupSyncEvents,
  vaultBackupObserverSeams,
} from "./vault-backup-observer.js";
import {
  drainBackupWebhooks,
  vaultBackupSyncSeams,
} from "./vault-backup-sync.js";
const originalDrain = vaultBackupSyncSeams.drainWebhookPending;
afterEach(() => {
  stopVaultBackupObserver();
  markDecoySession(false);
  vaultBackupSyncSeams.drainWebhookPending = originalDrain;
  vi.restoreAllMocks();
});
it("does not admit automatic backup jobs or manual sync work in a synthetic session", async () => {
  vi.spyOn(backupEgressGate, "allowed").mockReturnValue(true);
  const interval = vi.spyOn(globalThis, "setInterval");
  const drain = vi.fn(async () => 0);
  vaultBackupSyncSeams.drainWebhookPending = drain;
  markDecoySession(true);
  expect(backupEgressGate.running()).toBe(false);
  startVaultBackupObserver();
  await vaultBackupObserverSeams.pollWebhooks();
  await vaultBackupObserverSeams.runSync("manual");
  await expect(drainBackupWebhooks()).rejects.toThrow(
    "This session cannot use external",
  );
  expect(interval).not.toHaveBeenCalled();
  expect(drain).not.toHaveBeenCalled();
});
it("tears down an admitted observer when its pending webhook poll crosses into a synthetic session", async () => {
  vi.spyOn(backupEgressGate, "allowed").mockReturnValue(true);
  const interval = vi.spyOn(globalThis, "setInterval");
  const clear = vi.spyOn(globalThis, "clearInterval");
  let finish: (count: number) => void = () => {
    throw new Error("Poll has not started.");
  };
  const pending = new Promise<number>((resolve) => {
    finish = resolve;
  });
  vaultBackupSyncSeams.drainWebhookPending = () => pending;
  const events = vi.fn();
  const unsubscribe = subscribeBackupSyncEvents(events);
  try {
    startVaultBackupObserver();
    expect(interval).toHaveBeenCalledTimes(1);
    markDecoySession(true);
    finish(1);
    await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    expect(events).not.toHaveBeenCalled();
    markDecoySession(false);
    expect(isDecoySession()).toBe(false);
    expect(requiresFreshOwnerAuthentication()).toBe(true);
    const retry = vi.fn(async () => 0);
    vaultBackupSyncSeams.drainWebhookPending = retry;
    startVaultBackupObserver();
    await vaultBackupObserverSeams.pollWebhooks();
    await vaultBackupObserverSeams.runSync("manual");
    await expect(drainBackupWebhooks()).rejects.toThrow(
      "This session cannot use external",
    );
    expect(interval).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
  }
});
it("keeps ordinary webhook polling failures retryable without an unhandled promise", async () => {
  vi.spyOn(backupEgressGate, "allowed").mockReturnValue(true);
  const clear = vi.spyOn(globalThis, "clearInterval");
  vaultBackupSyncSeams.drainWebhookPending = async () => {
    throw new Error("Temporary relay failure.");
  };
  await expect(
    vaultBackupObserverSeams.pollWebhooks(),
  ).resolves.toBeUndefined();
  expect(clear).not.toHaveBeenCalled();
  const retry = vi.fn(async () => 0);
  vaultBackupSyncSeams.drainWebhookPending = retry;
  await vaultBackupObserverSeams.pollWebhooks();
  expect(retry).toHaveBeenCalledTimes(1);
});
