/**
 * Offline backups on this device: the last ciphertext snapshot for offline
 * reads, and the queue of mutations made while the Host was unreachable. The
 * envelope format itself is `offline-backup-format.ts`.
 */
import { overlapCast } from "@opensesame/os-domain";
import {
  type OfflineBackupEnvelope,
  type SyncBlobCiphertext,
  buildOfflineBackupEnvelope,
  parseOfflineBackupEnvelope,
  serializeOfflineBackupEnvelope,
} from "@opensesame/vault-core";
import { kvGet, kvSet } from "../kv.js";

export {
  MAX_OFFLINE_BACKUP_BYTES,
  OFFLINE_BACKUP_FORMAT,
  OFFLINE_BACKUP_VERSION,
  type OfflineBackupEnvelope,
  type SyncBlobCiphertext,
  assertCiphertextOnlyBackupJson,
  refuseDeploymentSealWrap,
} from "@opensesame/vault-core";

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

function cacheKey(projectId: string | null): string {
  return `${CACHE_KEY_PREFIX}${projectId ?? "_default"}`;
}

/** Persist last known ciphertext envelope for offline reads. */
function cacheCiphertextSnapshotDefault(envelope: OfflineBackupEnvelope): void {
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
    const parsed = overlapCast(JSON.parse(raw));
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
function enqueueOfflineMutationDefault(
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
    crypto !== undefined && "randomUUID" in crypto
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

export const offlineBackupSeams = {
  buildOfflineBackup: buildOfflineBackupEnvelope,
  serializeOfflineBackup: serializeOfflineBackupEnvelope,
  parseOfflineBackup: parseOfflineBackupEnvelope,
  cacheCiphertextSnapshot: cacheCiphertextSnapshotDefault,
  enqueueOfflineMutation: enqueueOfflineMutationDefault,
};

export function buildOfflineBackup(
  input: Parameters<typeof buildOfflineBackupEnvelope>[0],
): OfflineBackupEnvelope {
  return offlineBackupSeams.buildOfflineBackup(input);
}

export function serializeOfflineBackup(
  envelope: OfflineBackupEnvelope,
): string {
  return offlineBackupSeams.serializeOfflineBackup(envelope);
}

export function parseOfflineBackup(fileText: string): OfflineBackupEnvelope {
  return offlineBackupSeams.parseOfflineBackup(fileText);
}

export function cacheCiphertextSnapshot(envelope: OfflineBackupEnvelope): void {
  offlineBackupSeams.cacheCiphertextSnapshot(envelope);
}

export function enqueueOfflineMutation(
  input: Parameters<typeof enqueueOfflineMutationDefault>[0],
): OfflineVaultMutation {
  return offlineBackupSeams.enqueueOfflineMutation(input);
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
