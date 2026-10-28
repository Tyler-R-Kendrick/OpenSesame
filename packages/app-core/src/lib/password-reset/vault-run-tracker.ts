/**
 * Per-item password-reset run phase for vault chrome. Metadata only — no
 * secrets, origins, or provider responses.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { kvGet, kvSet } from "../kv.js";

export const VAULT_RESET_RUNS_KEY = "password-reset.vault-runs.v1";

export type VaultResetRunPhase =
  | "queued"
  | "in-progress"
  | "needs-you"
  | "done"
  | "failed";

export type VaultResetRunRecord = {
  scope: string;
  itemId: string;
  phase: VaultResetRunPhase;
  updatedAt: string;
  detail: string | null;
  /** Host rotation job id for this run, when the hand-off was accepted. */
  runId: string | null;
};

const listeners = new Set<() => void>();

export function subscribeVaultResetRuns(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

function readAll(): VaultResetRunRecord[] {
  const raw = kvGet(VAULT_RESET_RUNS_KEY);
  if (!raw) return [];
  try {
    const parsed = overlapCast<unknown, BoundaryValue>(JSON.parse(raw));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => parseRecord(entry) ?? []);
  } catch {
    return [];
  }
}

function parseRecord(value: BoundaryValue): VaultResetRunRecord | null {
  if (!isJsonObject(value)) return null;
  if (!isString(value.scope) || !isString(value.itemId)) return null;
  if (!isString(value.phase) || !isString(value.updatedAt)) return null;
  const phase = value.phase;
  if (
    phase !== "queued" &&
    phase !== "in-progress" &&
    phase !== "needs-you" &&
    phase !== "done" &&
    phase !== "failed"
  ) {
    return null;
  }
  const detail =
    value.detail === null || value.detail === undefined
      ? null
      : isString(value.detail)
        ? value.detail
        : null;
  return {
    scope: value.scope,
    itemId: value.itemId,
    phase,
    updatedAt: value.updatedAt,
    detail,
    runId: isString(value.runId) ? value.runId : null,
  };
}

function writeAll(records: VaultResetRunRecord[]): void {
  kvSet(VAULT_RESET_RUNS_KEY, JSON.stringify(records));
  emit();
}

export function vaultResetRunFor(
  scope: string,
  itemId: string,
): VaultResetRunRecord | null {
  return (
    readAll().find(
      (record) => record.scope === scope && record.itemId === itemId,
    ) ?? null
  );
}

export function listVaultResetRuns(): VaultResetRunRecord[] {
  return readAll();
}

export function setVaultResetRunPhase(
  scope: string,
  itemId: string,
  phase: VaultResetRunPhase,
  detail: string | null,
  now = new Date(),
  runId?: string | null,
): VaultResetRunRecord {
  const existing = vaultResetRunFor(scope, itemId);
  const next: VaultResetRunRecord = {
    scope,
    itemId,
    phase,
    updatedAt: now.toISOString(),
    detail,
    runId: runId === undefined ? (existing?.runId ?? null) : runId,
  };
  const rest = readAll().filter(
    (record) => record.scope !== scope || record.itemId !== itemId,
  );
  if (phase === "done") {
    writeAll(rest);
    return next;
  }
  writeAll([...rest, next]);
  return next;
}

export function clearVaultResetRunsForTest(): void {
  kvSet(VAULT_RESET_RUNS_KEY, "[]");
  emit();
}
