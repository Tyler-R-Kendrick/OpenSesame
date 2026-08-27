/**
 * Push sealed vault ciphertext to Host after every local persist (ADR 0039).
 *
 * Local OPFS remains the interactive store. Host sync blobs feed the gateway
 * backup outbox so the GitHub backup actor can commit+push. Plaintext and
 * unlock keys never leave the device.
 */

import {
  type BoundaryObject,
  type BoundaryValue,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import {
  ensureHostSession,
  hostFetch,
  hostLocalSessionEligible,
} from "../identity.js";
import { activeProject } from "../projects.js";
import {
  type SyncBlobCiphertext,
  dequeueOfflineMutation,
  enqueueOfflineMutation,
  listOfflineMutations,
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

function responseError(body: BoundaryValue, fallback: string): string {
  if (!isTypeofObject(body) || body === null || Array.isArray(body)) {
    return fallback;
  }
  const row: BoundaryObject = overlapCast(body);
  if (isString(row.hint)) return row.hint;
  return isString(row.error) ? row.error : fallback;
}

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

function getVaultHostBackupStateDefault(): VaultHostBackupState {
  return {
    ...state,
    pendingCount: listOfflineMutations().filter(
      (m) => m.kind === "push_sync_blobs",
    ).length,
  };
}

function subscribeVaultHostBackupDefault(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

type HostBackupSeams = {
  getVaultHostBackupState: () => VaultHostBackupState;
  subscribeVaultHostBackup: (listener: () => void) => () => void;
  mergePulledVault?: (input: {
    headerJson: string;
    bodyJson: string;
    epoch: number;
  }) => Promise<void>;
};

export const hostBackupSeams: HostBackupSeams = {
  getVaultHostBackupState: getVaultHostBackupStateDefault,
  subscribeVaultHostBackup: subscribeVaultHostBackupDefault,
};

export function getVaultHostBackupState(): VaultHostBackupState {
  return hostBackupSeams.getVaultHostBackupState();
}

export function subscribeVaultHostBackup(listener: () => void): () => void {
  return hostBackupSeams.subscribeVaultHostBackup(listener);
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
    if (globalThis.navigator !== undefined && navigator.onLine === false) {
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
    const outcome = await readPushResult(res);
    if (outcome.rejectedOversize > 0) {
      throw new Error(
        "Vault ciphertext exceeds Host sync size limit — backup did not accept this write",
      );
    }
    if (outcome.rejectedStale > 0 || outcome.rejectedBatch > 0) {
      await mergeLatestHostVault(projectId);
      return;
    }
    if (outcome.accepted < 1) {
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

type SyncPushResult = {
  accepted: number;
  rejectedOversize: number;
  rejectedStale: number;
  rejectedBatch: number;
};

async function readPushResult(res: Response): Promise<SyncPushResult> {
  if (!res.ok) {
    const body: BoundaryValue = await res.json().catch(() => ({}));
    throw new Error(responseError(body, `Host sync refused (${res.status})`));
  }
  const outcome: BoundaryValue = await res.json().catch(() => ({}));
  const row: BoundaryObject =
    isTypeofObject(outcome) && outcome !== null && !Array.isArray(outcome)
      ? overlapCast(outcome)
      : {};
  return {
    accepted: isNumber(row.accepted) ? row.accepted : 0,
    rejectedOversize: isNumber(row.rejected_oversize)
      ? row.rejected_oversize
      : 0,
    rejectedStale: isNumber(row.rejected_stale_epoch)
      ? row.rejected_stale_epoch
      : 0,
    rejectedBatch: isNumber(row.rejected_batch) ? row.rejected_batch : 0,
  };
}

async function mergeLatestHostVault(projectId: string): Promise<void> {
  const merge = hostBackupSeams.mergePulledVault;
  if (!merge) throw new Error("unlock the vault before merging");
  const res = await hostFetch("/api/v1/sync/blobs/pull", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ since_epoch: 0 }),
  });
  if (!res.ok) throw new Error(`Host sync pull failed (${res.status})`);
  const parsed: BoundaryValue = await res.json();
  if (!isTypeofObject(parsed) || parsed === null || Array.isArray(parsed)) {
    throw new Error("Host returned a malformed sync pull");
  }
  const blobs = overlapCast(parsed).blobs;
  if (!Array.isArray(blobs)) throw new Error("Host returned no sync blobs");
  const headerId = vaultBlobId("header", projectId);
  const bodyId = vaultBlobId("body", projectId);
  const candidates: Array<{
    id: string;
    epoch: number;
    ciphertext: number[];
  }> = [];
  for (const blob of blobs) {
    if (!isTypeofObject(blob) || blob === null || Array.isArray(blob)) continue;
    const row: BoundaryObject = overlapCast(blob);
    const ciphertext =
      Array.isArray(row.ciphertext) && row.ciphertext.every(isNumber)
        ? row.ciphertext.map(Number)
        : null;
    if (
      (row.id === headerId || row.id === bodyId) &&
      isString(row.id) &&
      isNumber(row.epoch) &&
      ciphertext
    ) {
      candidates.push({
        id: row.id,
        epoch: row.epoch,
        ciphertext,
      });
    }
  }
  const epochs = candidates
    .filter((blob) => blob.id === headerId)
    .map((blob) => blob.epoch)
    .filter((epoch) =>
      candidates.some((blob) => blob.id === bodyId && blob.epoch === epoch),
    );
  const epoch = Math.max(...epochs);
  if (!Number.isSafeInteger(epoch)) {
    throw new Error("Host has no complete vault revision");
  }
  const decode = (id: string): string => {
    const bytes = candidates.find(
      (blob) => blob.id === id && blob.epoch === epoch,
    )?.ciphertext;
    if (!bytes) throw new Error("Host has an incomplete vault revision");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(bytes),
    );
  };
  await merge({
    headerJson: decode(headerId),
    bodyJson: decode(bodyId),
    epoch,
  });
}

/** Drain queued ciphertext pushes (online / foreground). */
export async function flushPendingVaultHostBackup(): Promise<number> {
  const pending = listOfflineMutations().filter(
    (m) => m.kind === "push_sync_blobs",
  );
  if (pending.length === 0) return 0;
  if (navigator !== undefined && navigator.onLine === false) {
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
      const outcome = await readPushResult(res);
      if (outcome.rejectedOversize > 0) {
        throw new Error("queued vault ciphertext exceeds the Host size limit");
      }
      if (outcome.rejectedStale > 0 || outcome.rejectedBatch > 0) {
        await mergeLatestHostVault(item.projectId ?? "personal");
      } else if (outcome.accepted < 1) {
        throw new Error("Host accepted no queued vault sync blobs");
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
      lastError: listOfflineMutations().some(
        (m) => m.kind === "push_sync_blobs",
      )
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
  if (flushHooksInstalled || globalThis.window === undefined) return;
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
