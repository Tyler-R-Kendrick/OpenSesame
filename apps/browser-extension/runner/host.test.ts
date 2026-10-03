import { createApiClient } from "@opensesame/api-client";
import { describe, expect, it } from "vitest";
import { b64, toB64 } from "./bytes";
import { connector, hostBackup, recoverBackup } from "./host";
import { RunnerSettings } from "./settings";
import { SealedKv } from "./store";
import { MemoryStore, useTestDeviceKey } from "./test-support/memory";

interface SyncOptions {
  /** How many of a pushed batch the Host says it accepted. */
  accept?: number;
  pageSize?: number;
}

/** A Host's sync routes: push stores, pull-page pages by ingestion sequence. */
function syncHost(options: SyncOptions = {}) {
  const stored: { id: string; sequence: number; b64: string }[] = [];
  const calls: { path: string; auth: string | null; body: unknown }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({
      path,
      auth: new Headers(init?.headers).get("authorization"),
      body,
    });
    if (path === "/api/v1/sync/push") {
      const blobs: { id: string; ciphertext: number[] }[] = body.blobs;
      for (const blob of blobs) {
        stored.push({
          id: blob.id,
          sequence: stored.length + 1,
          b64: toB64(Uint8Array.from(blob.ciphertext)),
        });
      }
      return Response.json({
        accepted: options.accept ?? blobs.length,
        rejected_foreign_owner: 0,
        rejected_oversize: 0,
        rejected_session_quota: 0,
        rejected_stale_epoch: 0,
      });
    }
    const after = body.after ?? { epoch: 0, id: "" };
    const size = options.pageSize ?? 64;
    // The Host's keyset order: (sequence, id) strictly after the cursor.
    const rest = stored.filter(
      (s) =>
        s.sequence > after.epoch ||
        (s.sequence === after.epoch && s.id > after.id),
    );
    const page = rest.slice(0, size);
    const last = page.at(-1);
    return Response.json({
      format: "opensesame-sync-page",
      version: 2,
      blobs: page.map((s) => ({
        id: s.id,
        epoch: s.sequence,
        ciphertext_epoch: 1,
        ciphertext_b64: s.b64,
      })),
      next_after: last ? { epoch: last.sequence, id: last.id } : null,
      has_more: rest.length > page.length,
      serialized_bytes: 0,
      plaintext: null,
    });
  };
  return { stored, calls, fetchImpl };
}

const client = (fetchImpl: typeof fetch) =>
  createApiClient({
    baseUrl: "http://127.0.0.1:8787",
    accessToken: "tok",
    fetchImpl,
  });

describe("the Host's ciphertext store as a backup", () => {
  const bytes = new TextEncoder().encode('{"v":1,"ct":"opaque"}');

  it("accepts one blob, and proves it by reading the very same bytes back", async () => {
    const host = syncHost();
    const store = hostBackup(client(host.fetchImpl));
    expect(await store.push("runner-candidate.a", bytes)).toBe(true);
    expect(await store.confirm("runner-candidate.a", bytes)).toBe(true);
    expect(await store.confirm("runner-candidate.a", new Uint8Array([1]))).toBe(
      false,
    );
    expect(await store.confirm("runner-candidate.other", bytes)).toBe(false);
    expect(host.calls[0]?.auth).toBe("Bearer tok");
  });

  it("finds a blob that is many pages in", async () => {
    const host = syncHost({ pageSize: 2 });
    for (let i = 0; i < 9; i += 1)
      host.stored.push({ id: `x${i}`, sequence: i + 1, b64: "AAAA" });
    const store = hostBackup(client(host.fetchImpl));
    await store.push("runner-candidate.late", bytes);
    expect(await store.confirm("runner-candidate.late", bytes)).toBe(true);
    expect(
      host.calls.filter((c) => c.path.endsWith("pull-page")).length,
    ).toBeGreaterThan(4);
  });

  it("does not take a refusal for an acknowledgement", async () => {
    for (const accept of [0, 2]) {
      const store = hostBackup(client(syncHost({ accept }).fetchImpl));
      expect(await store.push("runner-candidate.a", bytes)).toBe(false);
    }
    const refusing: typeof fetch = async () =>
      Response.json({ accepted: 1, rejected_stale_epoch: 1 });
    expect(
      await hostBackup(client(refusing)).push("runner-candidate.a", bytes),
    ).toBe(false);
    const garbled: typeof fetch = async () => Response.json([1]);
    expect(
      await hostBackup(client(garbled)).push("runner-candidate.a", bytes),
    ).toBe(false);
  });

  it("recovers the ciphertext for the person who holds the key", async () => {
    const host = syncHost();
    await hostBackup(client(host.fetchImpl)).push("runner-candidate.a", bytes);
    expect(
      await recoverBackup(client(host.fetchImpl), "runner-candidate.a"),
    ).toEqual(bytes);
    expect(
      await recoverBackup(client(host.fetchImpl), "runner-candidate.none"),
    ).toBeNull();
    expect(b64.from(toB64(bytes))).toEqual(bytes);
  });
});

describe("the runner's connection", () => {
  it("is none without a session, and otherwise carries it as the bearer", async () => {
    useTestDeviceKey();
    const settings = new RunnerSettings(new SealedKv(new MemoryStore()));
    const seen: (string | null)[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return Response.json({ runs: [] });
    };
    const connect = connector(
      settings,
      async () => "http://127.0.0.1:8787",
      fetchImpl,
    );
    expect(await connect()).toBeNull();
    await settings.setToken("  the-session  ");
    const link = await connect();
    expect(await link?.host.listRuns()).toEqual([]);
    expect(seen).toEqual(["Bearer the-session"]);
  });
});
