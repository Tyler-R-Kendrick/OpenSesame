/**
 * Push sealed vault ciphertext to Host after every local persist (ADR 0039).
 *
 * Local OPFS remains the interactive store. Host sync blobs feed the gateway
 * backup outbox so the GitHub backup actor can commit+push. Plaintext and
 * unlock keys never leave the device.
 */

import {
  ensureHostSession,
  hostFetch,
  hostLocalSessionEligible,
} from "../identity.js";
import { activeProject } from "../projects.js";
import {
  enqueueOfflineMutation,
  listOfflineMutations,
  dequeueOfflineMutation,
  type SyncBlobCiphertext,
} from "./offline-backup.js";

export type VaultHostBackupState = {
  /** Last successful Host push (ISO), or null. */
  lastPushedAt: string | null;
  /** Human-readable outstanding problem, or null when healthy. */
  lastError: string | null;
  /** Ciphertext mutations waiting for Host / network. */
  pendingCount: number;
};

const listeners = new Set<() => void>();
let state: VaultHostBackupState = {
  lastPushedAt: null,
  lastError: null,
  pendingCount: 0,
};

function emit(next: Partial<VaultHostBackupState>): void {
  state = {
    ...state,
    ...next,
    pendingCount: listOfflineMutations().filter(
      (m) => m.kind === "push_sync_blobs",
    ).length,
  };
  for (const listener of listeners) listener();
}

export function getVaultHostBackupState(): VaultHostBackupState {
  return {
    ...state,
    pendingCount: listOfflineMutations().filter(
      (m) => m.kind === "push_sync_blobs",
    ).length,
  };
}

export function subscribeVaultHostBackup(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function vaultBlobId(kind: "header" | "body", projectId: string): string {
  if (projectId && projectId !== "personal") {
    return `project:${projectId}:vault:${kind}`;
  }
  return `vault:${kind}`;
}

function resolveProjectId(): string {
  try {
    return activeProject().id;
  } catch {
    return "personal";
  }
}

/**
 * After OPFS durable write: push sealed header+body to Host sync blobs.
 * Failures enqueue for retry — local vault write already succeeded.
 */
export async function pushSealedVaultToHost(input: {
  headerJson: string;
  bodyJson: string;
  epoch: number;
}): Promise<void> {
  const projectId = resolveProjectId();
  const blobs = [
    {
      id: vaultBlobId("header", projectId),
      epoch: input.epoch,
      ciphertext: utf8Bytes(input.headerJson),
    },
    {
      id: vaultBlobId("body", projectId),
      epoch: input.epoch,
      ciphertext: utf8Bytes(input.bodyJson),
    },
  ];

  try {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new Error("offline");
    }
    await ensureHostSession().catch(() => undefined);
    if (!hostLocalSessionEligible()) {
      // Still try — remote pairing may have a Host session.
    }
    const res = await hostFetch("/api/v1/sync/blobs/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blobs }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        hint?: string;
      };
      throw new Error(
        body.hint || body.error || `Host sync refused (${res.status})`,
      );
    }
    const outcome = (await res.json().catch(() => ({}))) as {
      accepted?: number;
      rejected_oversize?: number;
    };
    if ((outcome.rejected_oversize ?? 0) > 0) {
      throw new Error(
        "Vault ciphertext exceeds Host sync size limit — backup did not accept this write",
      );
    }
    if ((outcome.accepted ?? 0) < 1) {
      throw new Error("Host accepted no vault sync blobs");
    }
    emit({
      lastPushedAt: new Date().toISOString(),
      lastError: null,
    });
    await flushPendingVaultHostBackup();
  } catch (caught) {
    const message =
      caught instanceof Error ? caught.message : "Host vault backup failed";
    const queueBlobs: SyncBlobCiphertext[] = blobs.map((blob) => {
      let binary = "";
      for (const byte of blob.ciphertext) {
        binary += String.fromCharCode(byte);
      }
      return {
        id: blob.id,
        epoch: blob.epoch,
        ciphertextB64: btoa(binary),
      };
    });
    enqueueOfflineMutation({
      kind: "push_sync_blobs",
      projectId,
      blobs: queueBlobs,
    });
    emit({
      lastError: `Not on GitHub yet: ${message}. Retrying when Host is reachable.`,
    });
  }
}

function b64ToBytes(b64: string): number[] {
  const binary = atob(b64);
  const out: number[] = [];
  for (let i = 0; i < binary.length; i += 1) {
    out.push(binary.charCodeAt(i));
  }
  return out;
}

/** Drain queued ciphertext pushes (online / foreground). */
export async function flushPendingVaultHostBackup(): Promise<number> {
  const pending = listOfflineMutations().filter(
    (m) => m.kind === "push_sync_blobs",
  );
  if (pending.length === 0) return 0;
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return 0;
  }
  let flushed = 0;
  await ensureHostSession().catch(() => undefined);
  for (const item of pending) {
    if (item.kind !== "push_sync_blobs" || !item.blobs?.length) {
      dequeueOfflineMutation(item.id);
      continue;
    }
    try {
      const res = await hostFetch("/api/v1/sync/blobs/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          blobs: item.blobs.map((blob) => ({
            id: blob.id,
            epoch: blob.epoch,
            ciphertext: b64ToBytes(blob.ciphertextB64),
          })),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          hint?: string;
        };
        throw new Error(body.hint || body.error || `sync ${res.status}`);
      }
      dequeueOfflineMutation(item.id);
      flushed += 1;
    } catch (caught) {
      emit({
        lastError:
          caught instanceof Error
            ? `Pending GitHub backup: ${caught.message}`
            : "Pending GitHub backup failed",
      });
      break;
    }
  }
  if (flushed > 0) {
    emit({
      lastPushedAt: new Date().toISOString(),
      lastError:
        listOfflineMutations().some((m) => m.kind === "push_sync_blobs")
          ? state.lastError
          : null,
    });
  } else {
    emit({});
  }
  return flushed;
}

/** Start online/visibility flush listeners once per page load. */
let flushHooksInstalled = false;
export function installVaultHostBackupFlushHooks(): void {
  if (flushHooksInstalled || typeof window === "undefined") return;
  flushHooksInstalled = true;
  window.addEventListener("online", () => {
    void flushPendingVaultHostBackup();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void flushPendingVaultHostBackup();
    }
  });
  void flushPendingVaultHostBackup();
}
