import { backupEgressGate } from "./backup-egress-gate.js";
/**
 * SPA backup observer: configure / enable / manual / vault mutation / webhook
 * nudges all route through one sync path when the bound target is enabled.
 */
import {
  type LocalBackupTarget,
  bumpLocalBackupPending,
  listLocalBackupTargets,
  readLocalBackupTarget,
  subscribeLocalBackupTarget,
} from "./backup-target-local.js";
import { drainBackupWebhooks, syncVaultBackup } from "./vault-backup-sync.js";
import { sealMark } from "./vault/store-fresh.js";
import { GUEST_TOMB, vaultStore } from "./vault/store.js";
import { HEADER_PATH, readPlaintextFile } from "./vfs.js";

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
  // A seal names a committed body, including edits that keep item counts fixed.
  // The header also carries enrollment/wrap changes; its revision may lag a body.
  return JSON.stringify([
    snap.tomb,
    snap.status,
    sealMark(snap.tomb),
    readPlaintextFile(snap.tomb, HEADER_PATH),
  ]);
}

/** A push the device makes on its own, as opposed to one a person asked for. */
const AUTOMATIC: ReadonlySet<BackupSyncReason> = new Set(["vault", "webhook"]);

function admitted(
  target: LocalBackupTarget,
  reason: BackupSyncReason,
): boolean {
  return (
    target.enabled &&
    (reason === "manual" ||
      target.kind !== "github_app" ||
      target.lastSyncedAt !== null)
  );
}

async function syncTarget(
  row: LocalBackupTarget,
  reason: BackupSyncReason,
): Promise<void> {
  const providerId = row.providerId ?? "github";
  const current = readLocalBackupTarget(providerId);
  if (!current || !admitted(current, reason)) return;
  await syncVaultBackup(providerId).catch(() => undefined);
}

async function syncOtherTargets(
  targets: LocalBackupTarget[],
  reason: BackupSyncReason,
): Promise<void> {
  if (!targets.length) return;
  if (inflight) return inflight;
  inflight = (async () => {
    for (const row of targets) await syncTarget(row, reason);
  })().finally(() => {
    inflight = null;
  });
  await inflight;
}

async function runSync(reason: BackupSyncReason): Promise<void> {
  // Withdrawn by the operator: nothing, not even a sync asked for by hand.
  if (!backupEgressGate.running()) return;
  if (AUTOMATIC.has(reason) && !backupEgressGate.allowed()) return;
  // Selecting a recovery repository authorizes reads, not replacing its backup.
  // Only a confirmed explicit first write admits subsequent automatic writes.
  const enabled = listLocalBackupTargets().filter((row) =>
    admitted(row, reason),
  );
  if (enabled.length === 0) return;
  if (reason === "webhook" || reason === "vault" || reason === "configured") {
    for (const row of enabled) bumpLocalBackupPending(row.providerId, 1);
  }
  // App writes already have a bounded per-destination FIFO. Submit each sealed
  // revision now so its original session, transport and ciphertext are captured
  // before any wait. Joining an older observer write would lose this revision.
  const appWrites = enabled
    .filter((row) => row.kind === "github_app")
    .map((row) => syncTarget(row, reason));
  const others = enabled.filter((row) => row.kind !== "github_app");
  await Promise.all([...appWrites, syncOtherTargets(others, reason)]);
}

export function publishBackupSyncEvent(reason: BackupSyncReason): void {
  const { tomb } = vaultStore.getSnapshot();
  if (tomb === GUEST_TOMB) return;
  const event: BackupSyncEvent = { reason };
  for (const listener of listeners) listener(event);
  // resyncBackup owns and awaits manual dispatch for its selected provider.
  if (reason !== "manual") void runSync(reason);
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
  if (!backupEgressGate.allowed()) return;
  let count: number;
  try {
    count = await drainBackupWebhooks();
  } catch {
    // Background polling owns its refusal; an explicit manual drain still rejects.
    return;
  }
  if (count > 0) publishBackupSyncEvent("webhook");
}

/** Idempotent — call once from the GitHub connector surface or app boot. */
export function startVaultBackupObserver(): () => void {
  if (started) {
    return () => undefined;
  }
  // Every caller — the capability's job, a Settings tile reading the status,
  // a target being enabled — lands here, so the network envelope is held here.
  if (!backupEgressGate.allowed()) {
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
