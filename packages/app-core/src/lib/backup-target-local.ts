/**
 * Device-local backup targets for the Pages SPA (ADR 0128).
 * One row per provider — GitHub App or forge git remote.
 */
import {
  type JsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
  readString,
} from "@opensesame/os-domain";

const PUBLIC_KEY = "opensesame.backup.targets";
const LEGACY_KEY = "opensesame.backup.target";
const listeners = new Set<() => void>();
/** Fallback when localStorage is missing (Vitest node, private mode). */
let memoryRaw: string | null = null;

export type LocalBackupTarget = {
  kind: string;
  providerId: string | null;
  connectionId: string | null;
  integrationId: string;
  installationId: string;
  owner: string;
  repo: string;
  branch: string;
  enabled: boolean;
  status: string;
  lastCommitSha: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  config: JsonObject | null;
  pendingEvents: number;
};

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeLocalBackupTarget(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function trimOrEmpty(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function trimOrNull(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function parseConfig(raw: JsonObject): LocalBackupTarget["config"] {
  const configRaw = raw.config;
  if (
    isTypeofObject(configRaw) &&
    configRaw !== null &&
    !Array.isArray(configRaw)
  ) {
    return overlapCast(configRaw);
  }
  return null;
}

function kindFieldsOk(
  kind: string,
  installationId: string,
  connectionId: string | null,
): boolean {
  if (kind === "github_app" && !installationId) return false;
  if (kind === "git_remote" && !connectionId) return false;
  return true;
}

function parseOne(raw: JsonObject): LocalBackupTarget | null {
  const owner = trimOrEmpty(readString(raw.owner));
  const repo = trimOrEmpty(readString(raw.repo));
  if (!owner || !repo) return null;
  const kind = trimOrEmpty(readString(raw.kind)) || "github_app";
  const installationId = trimOrEmpty(readString(raw.installationId));
  const connectionId = trimOrNull(readString(raw.connectionId));
  if (!kindFieldsOk(kind, installationId, connectionId)) return null;
  return {
    kind,
    providerId: trimOrNull(readString(raw.providerId)),
    connectionId,
    integrationId: trimOrEmpty(readString(raw.integrationId)),
    installationId,
    owner,
    repo,
    branch: trimOrEmpty(readString(raw.branch)) || "main",
    enabled: raw.enabled !== false,
    status: trimOrEmpty(readString(raw.status)) || "pending",
    lastCommitSha: trimOrNull(readString(raw.lastCommitSha)),
    lastSyncedAt: trimOrNull(readString(raw.lastSyncedAt)),
    lastError: trimOrNull(readString(raw.lastError)),
    config: parseConfig(raw),
    pendingEvents: isNumber(raw.pendingEvents)
      ? Math.max(0, Math.floor(raw.pendingEvents))
      : 0,
  };
}

function readBlob(): string | null {
  const store = globalThis.localStorage;
  if (store) {
    try {
      const multi = store.getItem(PUBLIC_KEY);
      if (multi) return multi;
      const legacy = store.getItem(LEGACY_KEY);
      if (legacy) return legacy;
    } catch {
      // fall through to memory
    }
  }
  return memoryRaw;
}

function writeBlob(raw: string | null): void {
  memoryRaw = raw;
  const store = globalThis.localStorage;
  if (!store) {
    notify();
    return;
  }
  try {
    if (raw === null) {
      store.removeItem(PUBLIC_KEY);
      store.removeItem(LEGACY_KEY);
    } else {
      store.setItem(PUBLIC_KEY, raw);
      store.removeItem(LEGACY_KEY);
    }
  } catch {
    // memory still holds the session copy
  }
  notify();
}

export function listLocalBackupTargets(): LocalBackupTarget[] {
  const raw = readBlob();
  if (!raw || !isString(raw)) return [];
  try {
    const parsed: JsonObject | JsonObject[] = overlapCast(JSON.parse(raw));
    if (Array.isArray(parsed)) {
      const rows: LocalBackupTarget[] = [];
      for (const item of parsed) {
        if (!isTypeofObject(item) || item === null) continue;
        const row = parseOne(overlapCast(item));
        if (row) rows.push(row);
      }
      return rows;
    }
    if (isTypeofObject(parsed) && parsed !== null) {
      const one = parseOne(overlapCast(parsed));
      return one ? [one] : [];
    }
    return [];
  } catch {
    return [];
  }
}

export function readLocalBackupTarget(
  providerId?: string | null,
): LocalBackupTarget | null {
  const rows = listLocalBackupTargets();
  if (providerId) {
    return (
      rows.find((row) => (row.providerId ?? "github") === providerId) ?? null
    );
  }
  return rows[0] ?? null;
}

export function writeLocalBackupTarget(target: LocalBackupTarget): void {
  const key = target.providerId ?? "github";
  const rows = listLocalBackupTargets().filter(
    (row) => (row.providerId ?? "github") !== key,
  );
  rows.push(target);
  writeBlob(JSON.stringify(rows));
}

export function clearLocalBackupTarget(providerId?: string | null): void {
  if (!providerId) {
    writeBlob(null);
    return;
  }
  const rows = listLocalBackupTargets().filter(
    (row) => (row.providerId ?? "github") !== providerId,
  );
  writeBlob(rows.length === 0 ? null : JSON.stringify(rows));
}

export function bumpLocalBackupPending(
  providerId: string | null | undefined,
  delta = 1,
): number {
  const current = readLocalBackupTarget(providerId);
  if (!current) return 0;
  const pendingEvents = Math.max(0, current.pendingEvents + delta);
  writeLocalBackupTarget({ ...current, pendingEvents });
  return pendingEvents;
}

export function clearLocalBackupPending(providerId?: string | null): void {
  const current = readLocalBackupTarget(providerId);
  if (!current || current.pendingEvents === 0) return;
  writeLocalBackupTarget({ ...current, pendingEvents: 0 });
}
