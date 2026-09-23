/**
 * View-model logic for `BackupSyncControls` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import type { BackupTargetView } from "../../lib/backup.js";

export function syncTone(
  target: BackupTargetView,
): "ok" | "err" | "warn" | "idle" {
  if (!target.enabled) return "idle";
  if (target.status === "error" || target.status === "suspended") return "err";
  if (target.status === "ok") return "ok";
  return "warn";
}

export function syncLabel(target: BackupTargetView, pending: number): string {
  if (!target.enabled) return "Backup off";
  if (target.lastError) return target.lastError;
  const synced = target.lastSyncedAt
    ? `Last sync ${target.lastSyncedAt}`
    : "Waiting for first sync";
  return pending > 0 ? `${synced} · ${pending} pending` : synced;
}

export function targetMatchesProvider(
  bound: BackupTargetView,
  providerId: string,
): boolean {
  return (
    bound.providerId === providerId ||
    (bound.kind === "github_app" && providerId === "github")
  );
}
