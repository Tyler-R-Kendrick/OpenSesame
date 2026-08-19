/**
 * Offline encrypted vault / sync-blob backup.
 *
 * # Threat model
 *
 * The backup file is **as sensitive as the vault**. It is an envelope of
 * already-sealed ciphertext (vault header + AES-GCM body, optional sync
 * blobs). Host never sees the vault recovery / unlock key. Anyone with the
 * file still needs the master password (or enrolled unlock) to open it.
 * Protect the file at rest on disk like a password database export.
 *
 * Never upload plaintext backups to Host. Never wrap with the Host deployment
 * / connection seal key (`OPENSESAME_CONNECTION_KEY`) — wrapping stays on the
 * device under the vault unlock key already baked into `header.wrap`.
 */

import { kvGet, kvSet } from "../kv.js";
import type { SealedBlob, VaultHeader } from "./crypto.js";

export const OFFLINE_BACKUP_FORMAT = "opensesame-offline-backup" as const;
export const OFFLINE_BACKUP_VERSION = 1 as const;
export const MAX_OFFLINE_BACKUP_BYTES = 64 * 1024 * 1024;
const MAX_SYNC_BLOBS = 4096;

export type SyncBlobCiphertext = {
  id: string;
  epoch: number;
  /** Base64 opaque ciphertext — never plaintext. */
  ciphertextB64: string;
};

export type OfflineBackupEnvelope = {
  format: typeof OFFLINE_BACKUP_FORMAT;
  v: typeof OFFLINE_BACKUP_VERSION;
  projectId: string | null;
  exportedAt: string;
  /** Ciphertext vault export — header is public params; body is sealed. */
  vault: {
    header: VaultHeader;
    body: SealedBlob;
  };
  /** Optional Host-sync opaque blobs (ciphertext only). */
  syncBlobs: SyncBlobCiphertext[];
  /** Explicitly records that deployment seal was not used. */
  deploymentSealUsed: false;
};

const CACHE_KEY_PREFIX = "vault.offline-ciphertext.v1:";
const MUTATION_QUEUE_KEY = "vault.offline-mutations.v1";
export const MAX_OFFLINE_MUTATIONS = 64;

export type OfflineVaultMutation =
  | {
      id: string;
      createdAt: string;
      kind: "replace_ciphertext_cache";
      projectId: string | null;
      envelopeJson: string;
    }
  | {
      id: string;
      createdAt: string;
      kind: "push_sync_blobs";
      projectId: string | null;
      blobs: SyncBlobCiphertext[];
    };

const FORBIDDEN_SUBSTRINGS = [
  '"plaintext"',
  '"password":',
  '"secret":',
  '"token":',
  "OPENSESAME_CONNECTION_KEY",
  "deployment_seal",
] as const;

/** Refuse envelopes that smuggle plaintext or claim a deployment seal wrap. */
export function assertCiphertextOnlyBackupJson(json: string): void {
  for (const needle of FORBIDDEN_SUBSTRINGS) {
    if (json.includes(needle)) {
      throw new Error(
        "refusing backup JSON with plaintext or deployment-seal fields",
      );
    }
  }
}

export function refuseDeploymentSealWrap(label: string): void {
  const lower = label.toLowerCase();
  if (
    lower.includes("connection_key") ||
    lower.includes("deployment_seal") ||
    lower.includes("opensesame_connection") ||
    lower.includes("broker_seal")
  ) {
    throw new Error("deployment seal key must never wrap offline backups");
  }
}

export function buildOfflineBackup(input: {
  projectId?: string | null;
  header: VaultHeader;
  body: SealedBlob;
  syncBlobs?: SyncBlobCiphertext[];
  exportedAt?: string;
}): OfflineBackupEnvelope {
  refuseDeploymentSealWrap("device-vault-unlock");
  if (!input.header || !input.body?.ivB64 || !input.body?.ctB64) {
    throw new Error("offline backup requires sealed vault header and body");
  }
  const envelope: OfflineBackupEnvelope = {
    format: OFFLINE_BACKUP_FORMAT,
    v: OFFLINE_BACKUP_VERSION,
    projectId: input.projectId ?? null,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    vault: {
      header: input.header,
      body: input.body,
    },
    syncBlobs: (input.syncBlobs ?? []).map((blob) => ({
      id: blob.id,
      epoch: blob.epoch,
      ciphertextB64: blob.ciphertextB64,
    })),
    deploymentSealUsed: false,
  };
  assertCiphertextOnlyBackupJson(JSON.stringify(envelope));
  return envelope;
}

export function serializeOfflineBackup(
  envelope: OfflineBackupEnvelope,
): string {
  if (envelope.deploymentSealUsed !== false) {
    throw new Error("offline backup must not use deployment seal");
  }
  const json = `${JSON.stringify(envelope, null, 2)}\n`;
  assertCiphertextOnlyBackupJson(json);
  return json;
}

export function parseOfflineBackup(fileText: string): OfflineBackupEnvelope {
  if (fileText.length > MAX_OFFLINE_BACKUP_BYTES) {
    throw new Error("That offline backup is larger than 64 MB.");
  }
  assertCiphertextOnlyBackupJson(fileText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("That file is not an OpenSesame offline backup.");
  }
  const row = parsed as Record<string, unknown>;
  if (
    row.format !== OFFLINE_BACKUP_FORMAT ||
    row.v !== OFFLINE_BACKUP_VERSION
  ) {
    throw new Error("That file is not an OpenSesame offline backup.");
  }
  if (row.deploymentSealUsed !== false) {
    throw new Error("That backup claims a deployment seal wrap — refused.");
  }
  const vault = row.vault as
    | { header?: VaultHeader; body?: SealedBlob }
    | undefined;
  if (!vault?.header || !vault.body?.ivB64 || !vault.body?.ctB64) {
    throw new Error("That backup is missing sealed vault ciphertext.");
  }
  const syncBlobs = Array.isArray(row.syncBlobs)
    ? (row.syncBlobs as SyncBlobCiphertext[])
    : [];
  if (syncBlobs.length > MAX_SYNC_BLOBS) {
    throw new Error("That backup has too many sync blobs.");
  }
  let syncBytes = 0;
  for (const blob of syncBlobs) {
    if (
      !blob ||
      typeof blob.id !== "string" ||
      typeof blob.epoch !== "number" ||
      typeof blob.ciphertextB64 !== "string" ||
      !blob.ciphertextB64
    ) {
      throw new Error("That backup has a malformed sync blob.");
    }
    syncBytes += blob.ciphertextB64.length;
    if (syncBytes > MAX_OFFLINE_BACKUP_BYTES) {
      throw new Error("That backup's sync ciphertext is larger than 64 MB.");
    }
  }
  return {
    format: OFFLINE_BACKUP_FORMAT,
    v: OFFLINE_BACKUP_VERSION,
    projectId: typeof row.projectId === "string" ? row.projectId : null,
    exportedAt:
      typeof row.exportedAt === "string"
        ? row.exportedAt
        : new Date().toISOString(),
    vault: { header: vault.header, body: vault.body },
    syncBlobs,
    deploymentSealUsed: false,
  };
}

function cacheKey(projectId: string | null): string {
  return `${CACHE_KEY_PREFIX}${projectId ?? "_default"}`;
}

/** Persist last known ciphertext envelope for offline reads. */
export function cacheCiphertextSnapshot(envelope: OfflineBackupEnvelope): void {
  const json = serializeOfflineBackup(envelope);
  kvSet(cacheKey(envelope.projectId), json);
}

/** Serve last cached ciphertext when Host is unreachable. */
export function loadCachedCiphertextSnapshot(
  projectId: string | null = null,
): OfflineBackupEnvelope | null {
  const raw = kvGet(cacheKey(projectId));
  if (!raw) return null;
  try {
    return parseOfflineBackup(raw);
  } catch {
    return null;
  }
}

function loadMutationQueue(): OfflineVaultMutation[] {
  try {
    const raw = kvGet(MUTATION_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as OfflineVaultMutation[];
    return Array.isArray(parsed) ? parsed.slice(-MAX_OFFLINE_MUTATIONS) : [];
  } catch {
    return [];
  }
}

function saveMutationQueue(items: OfflineVaultMutation[]): void {
  kvSet(
    MUTATION_QUEUE_KEY,
    JSON.stringify(items.slice(-MAX_OFFLINE_MUTATIONS)),
  );
}

/** Queue a ciphertext mutation while offline (never plaintext). */
export function enqueueOfflineMutation(
  input:
    | {
        kind: "replace_ciphertext_cache";
        projectId?: string | null;
        envelope: OfflineBackupEnvelope;
      }
    | {
        kind: "push_sync_blobs";
        projectId?: string | null;
        blobs: SyncBlobCiphertext[];
      },
): OfflineVaultMutation {
  const createdAt = new Date().toISOString();
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `mut-${createdAt}`;
  let item: OfflineVaultMutation;
  if (input.kind === "replace_ciphertext_cache") {
    item = {
      id,
      createdAt,
      kind: "replace_ciphertext_cache",
      projectId: input.projectId ?? null,
      envelopeJson: serializeOfflineBackup(input.envelope),
    };
  } else {
    for (const blob of input.blobs) {
      if (!blob.ciphertextB64) {
        throw new Error("offline queue refuses empty ciphertext");
      }
    }
    item = {
      id,
      createdAt,
      kind: "push_sync_blobs",
      projectId: input.projectId ?? null,
      blobs: input.blobs,
    };
  }
  saveMutationQueue([...loadMutationQueue(), item]);
  return item;
}

export function listOfflineMutations(): OfflineVaultMutation[] {
  return loadMutationQueue();
}

export function dequeueOfflineMutation(id: string): void {
  saveMutationQueue(loadMutationQueue().filter((item) => item.id !== id));
}

export function clearOfflineMutations(): void {
  saveMutationQueue([]);
}
