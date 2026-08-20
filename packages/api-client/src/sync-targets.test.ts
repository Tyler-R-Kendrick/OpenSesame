import { describe, expect, it } from "vitest";
import { createApiClient } from "./index.js";
import { type JsonObject, overlapCast, type BoundaryValue } from "@opensesame/os-domain";

const syncTarget = {
  id: "synctarget_01J",
  project_id: "project_01J",
  config_id: "config_01J",
  connection_id: "connection_01J",
  provider_id: "github",
  operation: "kv.read",
  status: "ready",
  status_detail: null,
  content_version: "v1",
  last_synced_at: "2026-08-08T10:05:00.000Z",
  organization_id: "organization_01J",
  created_at: "2026-08-08T10:00:00.000Z",
  updated_at: "2026-08-08T10:05:00.000Z",
};

const outcome = {
  target: syncTarget,
  ok: true,
  keys_synced: 3,
  content_version: "v2",
  error: null,
};

function jsonClient(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; method: string; body: string }[] = [];
  const client = createApiClient({
    baseUrl: "https://host.test:8787",
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        method: String(init?.method ?? "GET"),
        body: String(init?.body ?? ""),
      });
      return handler(String(input), init);
    },
  });
  return { calls, client };
}

function ok(body: BoundaryValue): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("api-client sync targets", () => {
  it("lists sync targets with and without filters", async () => {
    const { client, calls } = jsonClient(() =>
      ok({ sync_targets: [syncTarget] }),
    );

    await client.listSyncTargets();
    await client.listSyncTargets({ projectId: "project_01J" });
    await client.listSyncTargets({ configId: "config_01J" });
    const res = await client.listSyncTargets({
      projectId: "project_01J",
      configId: "config_01J",
    });

    expect(calls[0]?.url).toBe("https://host.test:8787/api/v1/sync-targets");
    expect(calls[1]?.url).toBe(
      "https://host.test:8787/api/v1/sync-targets?project_id=project_01J",
    );
    expect(calls[2]?.url).toBe(
      "https://host.test:8787/api/v1/sync-targets?config_id=config_01J",
    );
    expect(calls[3]?.url).toContain("project_id=project_01J");
    expect(calls[3]?.url).toContain("config_id=config_01J");
    expect(res.sync_targets[0]?.operation).toBe("kv.read");
  });

  it("creates, reads and deletes a sync target", async () => {
    const { client, calls } = jsonClient((_url, init) =>
      init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : ok(syncTarget),
    );

    const created = await client.createSyncTarget({
      project_id: "project_01J",
      config_id: "config_01J",
      connection_id: "connection_01J",
    });
    const fetched = await client.getSyncTarget("synctarget_01J");
    await client.deleteSyncTarget("synctarget_01J");

    expect(created.status).toBe("ready");
    expect(fetched.id).toBe("synctarget_01J");
    expect(calls[2]?.method).toBe("DELETE");
    expect(calls[2]?.url).toBe(
      "https://host.test:8787/api/v1/sync-targets/synctarget_01J",
    );
  });

  it("surfaces delete failures with the broker error code", async () => {
    const { client } = jsonClient(
      () =>
        new Response(JSON.stringify({ error: "sync_target_busy" }), {
          status: 409,
        }),
    );
    await expect(client.deleteSyncTarget("synctarget_01J")).rejects.toThrow(
      "sync_target_delete_failed:409:sync_target_busy",
    );
  });

  it("syncs one target, defaulting to an empty request body", async () => {
    const { client, calls } = jsonClient(() => ok(outcome));

    const res = await client.syncTarget("synctarget_01J");
    const named = await client.syncTarget("synctarget_01J", {
      key_names: ["api-token"],
    });

    expect(res.keys_synced).toBe(3);
    expect(named.target.provider_id).toBe("github");
    expect(calls[0]?.body).toBe("{}");
    expect(calls[0]?.url).toBe(
      "https://host.test:8787/api/v1/sync-targets/synctarget_01J/sync",
    );
    expect(calls[1]?.body).toBe('{"key_names":["api-token"]}');
  });

  it("syncs every target of a config", async () => {
    const { client, calls } = jsonClient(() => ok({ outcomes: [outcome] }));
    const res = await client.syncAllTargets("config_01J");
    expect(res.outcomes).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://host.test:8787/api/v1/sync-targets/sync-all",
    );
    expect(calls[0]?.body).toBe('{"config_id":"config_01J"}');
  });

  it("rejects sync-target responses that carry unexpected fields", async () => {
    const { client } = jsonClient(() =>
      ok({ sync_targets: [{ ...syncTarget, secret_values: ["k_live"] }] }),
    );
    await expect(client.listSyncTargets()).rejects.toThrow();
  });
});

describe("api-client invoke and E2EE sync", () => {
  it("invokes with defaults and explicit level/input", async () => {
    const { client, calls } = jsonClient(() => ok({ echoed: true }));

    await client.invoke({
      connectionRef: "conn://acme/web/github/main",
      operation: "repos.list",
      resource: "github:repos",
    });
    await client.invoke({
      connectionRef: "conn://acme/web/github/main",
      operation: "repos.create",
      resource: "github:repos",
      invokeLevel: 2,
      input: { name: "demo" },
    });

    const first = overlapCast(JSON.parse(calls[0]?.body ?? "{}"));
    expect(first).toMatchObject({
      connection_ref: "conn://acme/web/github/main",
      invoke_level: 1,
      input: {},
    });
    const second = overlapCast(JSON.parse(calls[1]?.body ?? "{}"));
    expect(second.invoke_level).toBe(2);
    expect(second.input).toEqual({ name: "demo" });
    // Never a SecretRef on the wire.
    expect(calls[0]?.body).not.toContain("secret_ref");
  });

  it("includes the raw status text when invoke is refused", async () => {
    const { client } = jsonClient(
      () => new Response("policy_denied", { status: 403 }),
    );
    await expect(
      client.invoke({
        connectionRef: "conn://acme/web/github/main",
        operation: "repos.delete",
        resource: "github:repos",
      }),
    ).rejects.toThrow("invoke_failed:403:policy_denied");
  });

  it("pushes blobs as byte arrays decoded from base64", async () => {
    const { client, calls } = jsonClient(() => ok({ accepted: 1 }));
    // base64 for bytes [1, 2, 3, 255]
    const ciphertextB64 = btoa(String.fromCharCode(1, 2, 3, 255));
    await client.syncPush([{ id: "blob_01J", epoch: 4, ciphertextB64 }]);
    const body = overlapCast(JSON.parse(calls[0]?.body ?? "{}"));
    expect(body.blobs[0]?.ciphertext).toEqual([1, 2, 3, 255]);
    expect(calls[0]?.url).toBe("https://host.test:8787/api/v1/sync/push");
  });

  it("fails loudly when push or pull is refused", async () => {
    const { client } = jsonClient(() => new Response("no", { status: 503 }));
    await expect(
      client.syncPush([{ id: "blob_01J", epoch: 1, ciphertextB64: "AA==" }]),
    ).rejects.toThrow("sync_push_failed:503");
    await expect(
      client.syncPull({ deviceId: "dev-a", epoch: 0 }),
    ).rejects.toThrow("sync_pull_failed:503");
  });
});
