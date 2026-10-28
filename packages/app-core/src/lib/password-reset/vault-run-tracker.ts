/**
 * Per-item password-reset run phase for vault chrome. Metadata only — no
 * secrets, origins, or provider responses.
 */

import { isJsonObject, isString } from "@opensesame/os-domain";
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
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => parseRecord(entry) ?? []);
  } catch {
    return [];
  }
}

function parseRecord(value: unknown): VaultResetRunRecord | null {
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

export function setVaultResetRunPhase(
  scope: string,
  itemId: string,
  phase: VaultResetRunPhase,
  detail: string | null,
  now = new Date(),
): VaultResetRunRecord {
  const next: VaultResetRunRecord = {
    scope,
    itemId,
    phase,
    updatedAt: now.toISOString(),
    detail,
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
