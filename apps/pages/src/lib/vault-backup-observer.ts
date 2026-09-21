/**
 * SPA backup observer: configure / enable / manual / vault mutation / webhook
 * nudges all route through one sync path when the bound target is enabled.
 */
import {
  bumpLocalBackupPending,
  listLocalBackupTargets,
  subscribeLocalBackupTarget,
} from "./backup-target-local.js";
import { drainBackupWebhooks, syncVaultBackup } from "./vault-backup-sync.js";
import { GUEST_TOMB, vaultStore } from "./vault/store.js";

export type BackupSyncReason =
  | "configured"
  | "enabled"
  | "manual"
  | "vault"
  | "webhook";

type BackupSyncEvent = { reason: BackupSyncReason };

const listeners = new Set<(event: BackupSyncEvent) => void>();
let started = false;
let inflight: Promise<void> | null = null;
let vaultUnsub: (() => void) | null = null;
let targetUnsub: (() => void) | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastStatus = "";

function statusKey(): string {
  const snap = vaultStore.getSnapshot();
  return `${snap.tomb}:${snap.status}:${snap.items.length}:${snap.folders.length}`;
}

async function runSync(reason: BackupSyncReason): Promise<void> {
  const enabled = listLocalBackupTargets().filter((row) => row.enabled);
  if (enabled.length === 0) return;
  if (reason === "webhook" || reason === "vault" || reason === "configured") {
    for (const row of enabled) {
      bumpLocalBackupPending(row.providerId, 1);
    }
  }
  if (inflight) {
    await inflight;
    return;
  }
  inflight = syncVaultBackup()
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      inflight = null;
    });
  await inflight;
}

export function publishBackupSyncEvent(reason: BackupSyncReason): void {
  const { tomb } = vaultStore.getSnapshot();
  if (tomb === GUEST_TOMB) return;
  const event: BackupSyncEvent = { reason };
  for (const listener of listeners) listener(event);
  void runSync(reason);
}

export function subscribeBackupSyncEvents(
  listener: (event: BackupSyncEvent) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function pollWebhooks(): Promise<void> {
  const count = await drainBackupWebhooks();
  if (count > 0) publishBackupSyncEvent("webhook");
}

/** Idempotent — call once from the GitHub connector surface or app boot. */
export function startVaultBackupObserver(): () => void {
  if (started) {
    return () => undefined;
  }
  started = true;
  lastStatus = statusKey();
  vaultUnsub = vaultStore.subscribe(() => {
    const next = statusKey();
    if (next === lastStatus) return;
    lastStatus = next;
    const { status, tomb } = vaultStore.getSnapshot();
    if (status !== "unlocked" || tomb === GUEST_TOMB) return;
    publishBackupSyncEvent("vault");
  });
  targetUnsub = subscribeLocalBackupTarget(() => {
    // enable/configure paths call publishBackupSyncEvent explicitly
  });
  pollTimer = setInterval(() => {
    void pollWebhooks();
  }, 30_000);
  void pollWebhooks();
  return stopVaultBackupObserver;
}

export function stopVaultBackupObserver(): void {
  started = false;
  vaultUnsub?.();
  vaultUnsub = null;
  targetUnsub?.();
  targetUnsub = null;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export const vaultBackupObserverSeams = {
  runSync,
  publishBackupSyncEvent,
};
