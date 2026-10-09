/**
 * The Host, as the runner uses it: the run and step routes, and the Host's
 * ciphertext store as the place a candidate's backup is put and proven.
 *
 * Every call carries the person's own Host session. The base is the same
 * loopback-pinned one the popup shows (`resolveHostBase`), so a rewritten
 * setting cannot send a bearer anywhere else.
 */
import {
  type ApiClient,
  type ApiClientOptions,
  type SyncPageCursor,
  createApiClient,
} from "@opensesame/api-client";
import { isJsonObject } from "@opensesame/os-domain";
import type { BackupStore } from "./backup";
import { fromB64, toB64 } from "./bytes";
import type { Connection } from "./loop";
import type { RunnerSettings } from "./settings";

/** Pages of ciphertext read back while proving a backup: more than a Host holds. */
const MAX_PAGES = 64;

/** The blob under `id` in the Host's ciphertext store, if it holds one. */
async function findBlob(client: ApiClient, id: string) {
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

/** The ciphertext of a candidate's backup, for the person who holds its key. */
export async function recoverBackup(
  client: ApiClient,
  id: string,
): Promise<Uint8Array | null> {
  const held = await findBlob(client, id);
  return held ? fromB64(held.ciphertext_b64) : null;
}

/** The Host's opaque ciphertext store, through `/api/v1/sync/*`. */
export function hostBackup(client: ApiClient): BackupStore {
  return {
    async push(id, bytes) {
      const res = await client.syncPush([
        { id, epoch: 1, ciphertextB64: toB64(bytes) },
      ]);
      if (!isJsonObject(res)) return false;
      const refused = Object.entries(res).some(
        ([key, value]) => key.startsWith("rejected_") && value !== 0,
      );
      return res.accepted === 1 && !refused;
    },
    async confirm(id, bytes) {
      const held = await findBlob(client, id);
      return held !== undefined && held.ciphertext_b64 === toB64(bytes);
    },
  };
}

export function hostConnection(client: ApiClient): Connection {
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

/** A connection under the person's session, or null when they have none. */
export function connector(
  settings: RunnerSettings,
  resolveBase: () => Promise<string>,
  fetchImpl?: typeof fetch,
): () => Promise<Connection | null> {
  return async () => {
    const accessToken = await settings.token();
    if (accessToken === null) return null;
    const options: ApiClientOptions = {
      baseUrl: await resolveBase(),
      accessToken,
    };
    if (fetchImpl) options.fetchImpl = fetchImpl;
    return hostConnection(createApiClient(options));
  };
}
