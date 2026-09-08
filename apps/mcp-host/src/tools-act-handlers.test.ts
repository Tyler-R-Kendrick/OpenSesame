import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockAgentHeaders } from "./agent-headers-fixture.js";
import { callTool, jsonResponse, makeRegistrar } from "./handler-harness.js";
import { resetFetchForTests, setFetchForTests } from "./host-api.js";
import { setTaskContext } from "./task-context.js";

const ENV_KEYS = [
  "OPENSESAME_SERVER",
  "OPENSESAME_OPERATOR_TOKEN",
  "OPENSESAME_DAEMON_URL",
] as const;

describe("mcp-host act tool handlers", () => {
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    setTaskContext(null);
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    process.env.OPENSESAME_SERVER = "http://127.0.0.1:8787";
    mockAgentHeaders();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetFetchForTests();
    setTaskContext(null);
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    savedEnv.clear();
  });

  describe("sync_push", () => {
    it("converts base64 to byte arrays on the wire and returns counters", async () => {
      const calls: Array<{ url: string; body: string }> = [];
      setFetchForTests(async (input, init) => {
        calls.push({ url: String(input), body: String(init?.body) });
        return jsonResponse({
          accepted: 1,
          rejected_foreign_owner: 0,
          rejected_oversize: 0,
          rejected_session_quota: 0,
          rejected_stale_epoch: 0,
          rejected_batch: 0,
          owner_capacity: 512,
          max_ciphertext_bytes: 2097152,
          server_gossip: "another tenant pushed plaintext today",
        });
      });
      const handlers = makeRegistrar();

      const ciphertext = Buffer.from([1, 2, 3, 255]).toString("base64");
      const result = await callTool(handlers, "sync_push", {
        blobs: [{ id: "blob-1", epoch: 7, ciphertext_b64: ciphertext }],
      });

      expect(result.isError).toBe(false);
      expect(calls[0]?.url).toBe("http://127.0.0.1:8787/api/v1/sync/push");
      const sent = JSON.parse(calls[0]?.body ?? "{}");
      expect(sent.blobs[0].ciphertext).toEqual([1, 2, 3, 255]);
      expect(result.content[0]?.text).toContain('"accepted":1');
      expect(result.content[0]?.text).not.toContain("server_gossip");
    });
  });

  describe("sync_pull", () => {
    it("returns opaque blobs as base64 and drops chatty extras", async () => {
      const calls: Array<{ url: string; body: string }> = [];
      setFetchForTests(async (input, init) => {
        calls.push({ url: String(input), body: String(init?.body) });
        return jsonResponse({
          format: "opensesame-sync-page",
          version: 2,
          blobs: [
            {
              id: "blob-1",
              epoch: 7,
              ciphertext_epoch: 1,
              ciphertext_b64: "AQID/w==",
            },
          ],
          next_after: { epoch: 7, id: "blob-1" },
          has_more: false,
          plaintext: null,
          note: "ciphertext only",
          device_cursor: 7,
          daemon_default_listen: "127.0.0.1:18790",
        });
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "sync_pull", {
        since_epoch: 3,
        device_id: "device-1",
      });

      expect(result.isError).toBe(false);
      const sent = JSON.parse(calls[0]?.body ?? "{}");
      expect(sent.after).toEqual({ epoch: 4, id: "" });
      expect(sent.device_id).toBe("device-1");
      expect(result.content[0]?.text).toContain(
        Buffer.from([1, 2, 3, 255]).toString("base64"),
      );
      expect(result.content[0]?.text).toContain('"ciphertext_epoch":1');
      expect(result.content[0]?.text).not.toContain("daemon_default_listen");
      expect(result.content[0]?.text).not.toContain("note");
    });

    it("maps a storage failure to an error", async () => {
      setFetchForTests(async () =>
        jsonResponse({ error: "sync_storage_failed" }, 500),
      );
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "sync_pull", {});

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("sync_pull_failed:500");
    });
  });
});
