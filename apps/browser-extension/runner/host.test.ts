import { describe, expect, it } from "vitest";
import { b64, toB64 } from "./bytes";
import { connector, hostBackup, recoverBackup } from "./host";
import type { RunnerHostClient, SyncPageCursor } from "./host-api-contract.js";
import { RunnerSettings } from "./settings";
import { SealedKv } from "./store";
import { MemoryStore, useTestDeviceKey } from "./test-support/memory";

interface SyncOptions {
  accept?: number;
  pageSize?: number;
}

function syncHost(options: SyncOptions = {}): RunnerHostClient {
  const stored: { id: string; sequence: number; b64: string }[] = [];
  return {
    async syncPush(blobs) {
      for (const blob of blobs) {
        stored.push({
          id: blob.id,
          sequence: stored.length + 1,
          b64: blob.ciphertextB64,
        });
      }
      return {
        accepted: options.accept ?? blobs.length,
        rejected_foreign_owner: 0,
        rejected_oversize: 0,
        rejected_session_quota: 0,
        rejected_stale_epoch: 0,
      };
    },
    async syncReadPage(after: SyncPageCursor) {
      const size = options.pageSize ?? 64;
      const rest = stored.filter(
        (s) =>
          s.sequence > after.epoch ||
          (s.sequence === after.epoch && s.id > after.id),
      );
      const page = rest.slice(0, size);
      const last = page.at(-1);
      return {
        blobs: page.map((s) => ({
          id: s.id,
          ciphertext_b64: s.b64,
        })),
        has_more: rest.length > page.length,
        ...(last ? { next_after: { epoch: last.sequence, id: last.id } } : {}),
      };
    },
    async listAgentRuns() {
      return [];
    },
    async getAgentRun(id) {
      throw new Error(`missing:${id}`);
    },
    async claimRunnerStep() {
      throw new Error("claim_unavailable");
    },
    async settleRunnerStep() {
      throw new Error("settle_unavailable");
    },
  };
}

describe("the Host's ciphertext store as a backup", () => {
  const bytes = new TextEncoder().encode('{"v":1,"ct":"opaque"}');

  it("accepts one blob, and proves it by reading the very same bytes back", async () => {
    const host = syncHost();
    const store = hostBackup(host);
    expect(await store.push("runner-candidate.a", bytes)).toBe(true);
    expect(await store.confirm("runner-candidate.a", bytes)).toBe(true);
    expect(await store.confirm("runner-candidate.a", new Uint8Array([1]))).toBe(
      false,
    );
    expect(await store.confirm("runner-candidate.other", bytes)).toBe(false);
  });

  it("finds a blob that is many pages in", async () => {
    const host = syncHost({ pageSize: 2 });
    for (let i = 0; i < 9; i += 1) {
      await host.syncPush([{ id: `x${i}`, epoch: 1, ciphertextB64: "AAAA" }]);
    }
    const store = hostBackup(host);
    await store.push("runner-candidate.late", bytes);
    expect(await store.confirm("runner-candidate.late", bytes)).toBe(true);
  });

  it("does not take a refusal for an acknowledgement", async () => {
    for (const accept of [0, 2]) {
      const store = hostBackup(syncHost({ accept }));
      expect(await store.push("runner-candidate.a", bytes)).toBe(false);
    }
    const refusing: RunnerHostClient = {
      ...syncHost(),
      async syncPush() {
        return { accepted: 1, rejected_stale_epoch: 1 };
      },
    };
    expect(await hostBackup(refusing).push("runner-candidate.a", bytes)).toBe(
      false,
    );
    const garbled: RunnerHostClient = {
      ...syncHost(),
      async syncPush() {
        return { accepted: 1 } as never;
      },
    };
    expect(await hostBackup(garbled).push("runner-candidate.a", bytes)).toBe(
      false,
    );
  });

  it("recovers the ciphertext for the person who holds the key", async () => {
    const host = syncHost();
    await hostBackup(host).push("runner-candidate.a", bytes);
    expect(await recoverBackup(host, "runner-candidate.a")).toEqual(bytes);
    expect(await recoverBackup(host, "runner-candidate.none")).toBeNull();
    expect(b64.from(toB64(bytes))).toEqual(bytes);
  });
});

describe("the runner's connection", () => {
  it("is none without a Host API in this build", async () => {
    useTestDeviceKey();
    const settings = new RunnerSettings(new SealedKv(new MemoryStore()));
    const connect = connector(settings, async () => "http://127.0.0.1:8787");
    expect(await connect()).toBeNull();
    await settings.setToken("  the-session  ");
    expect(await connect()).toBeNull();
  });
});
