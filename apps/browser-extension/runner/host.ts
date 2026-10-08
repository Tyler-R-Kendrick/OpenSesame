/**
 * Host runner connection types. The Host API was removed from this repository;
 * the runner loop still accepts an injected connection in tests.
 */
import { isJsonObject } from "@opensesame/os-domain";
import type { BackupStore } from "./backup";
import { fromB64, toB64 } from "./bytes";
import type { RunnerHostClient, SyncPageCursor } from "./host-api-contract.js";
import type { Connection } from "./loop";
import type { RunnerSettings } from "./settings";

const MAX_PAGES = 64;

// A push is acknowledged only by a full result shape: accepted === 1 and every
// rejection counter present and zero. A garbled or partial answer is a
// refusal, never an acknowledgement.
const REJECTION_COUNTERS = [
  "rejected_foreign_owner",
  "rejected_oversize",
  "rejected_session_quota",
  "rejected_stale_epoch",
] as const;

async function findBlob(client: RunnerHostClient, id: string) {
  let after: SyncPageCursor = { epoch: 1, id: "" };
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const read = await client.syncReadPage(after);
    const held = read.blobs.find((blob) => blob.id === id);
    if (held) return held;
    if (!read.has_more || !read.next_after) return undefined;
    after = read.next_after;
  }
  return undefined;
}

export async function recoverBackup(
  client: RunnerHostClient,
  id: string,
): Promise<Uint8Array | null> {
  const held = await findBlob(client, id);
  return held ? fromB64(held.ciphertext_b64) : null;
}

export function hostBackup(client: RunnerHostClient): BackupStore {
  return {
    async push(id, bytes) {
      const res = await client.syncPush([
        { id, epoch: 1, ciphertextB64: toB64(bytes) },
      ]);
      if (!isJsonObject(res)) return false;
      return (
        res.accepted === 1 && REJECTION_COUNTERS.every((key) => res[key] === 0)
      );
    },
    async confirm(id, bytes) {
      const held = await findBlob(client, id);
      return held !== undefined && held.ciphertext_b64 === toB64(bytes);
    },
  };
}

export function hostConnection(client: RunnerHostClient): Connection {
  return {
    host: {
      listRuns: () => client.listAgentRuns(),
      getRun: (id) => client.getAgentRun(id),
      claim: (runId) => client.claimRunnerStep(runId),
      settle: (runId, seq, outcome) =>
        client.settleRunnerStep(runId, seq, outcome),
    },
    backup: hostBackup(client),
  };
}

/** No Host API in this build — connector always yields null. */
export function connector(
  _settings: RunnerSettings,
  _resolveBase: () => Promise<string>,
  _fetchImpl?: typeof fetch,
): () => Promise<Connection | null> {
  return async () => null;
}
