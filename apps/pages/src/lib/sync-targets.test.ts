import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCapabilityConnectors } from "./capabilities.js";
import {
  clearHostSession,
  clearSession,
  connectProvisional,
} from "./identity.js";
import {
  saveSettings,
  shippedHostApi,
  shippedIdentityApi,
} from "./settings.js";
import {
  type SyncTarget,
  createSyncTarget,
  listSyncTargets,
  syncTarget,
} from "./sync-targets.js";

const HOST = shippedHostApi;
const IDENTITY = shippedIdentityApi;

function jsonResponse(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sampleTarget(overrides: Partial<SyncTarget> = {}): SyncTarget {
  return {
    id: "sync_target:1",
    projectId: "project:1",
    configId: "config:prod",
    connectionId: "connection:vercel",
    providerId: "vercel",
    operation: "env.set",
    status: "idle",
    statusDetail: null,
    contentVersion: null,
    lastSyncedAt: null,
    organizationId: "org:1",
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

function stubHostFetch(handler: (url: string, init?: RequestInit) => Response) {
  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** Session + Identity plumbing shared by every Host call in these tests. */
function withSession(handler: (url: string, init?: RequestInit) => Response) {
  return stubHostFetch((url, init) => {
    if (url === `${HOST}/api/v1/session/local`) {
      return jsonResponse({ error: "demo_bootstrap_unavailable" }, 503);
    }
    if (url === `${HOST}/api/v1/device/authorize`) {
      return jsonResponse({ device_code: "dc_st", user_code: "ABCD-STGH" });
    }
    if (url === `${IDENTITY}/v1/device/approve`) {
      return jsonResponse({ ok: true });
    }
    if (url === `${HOST}/api/v1/device/token`) {
      return jsonResponse({
        access_token: "opaque-session:sess_st",
        expires_in: 28_800,
      });
    }
    if (url === `${IDENTITY}/v1/principals/me`) {
      return jsonResponse({}, 401);
    }
    return handler(url, init);
  });
}

beforeEach(async () => {
  clearSession();
  clearHostSession();
  saveSettings({
    hostApi: HOST,
    identityApi: IDENTITY,
    daemonApi: "http://127.0.0.1:18790",
    tursoUrl: "",
    mfaAppUrl: "http://127.0.0.1:5177",
    capabilityConnectors: defaultCapabilityConnectors(),
  });
  withSession(() =>
    jsonResponse({
      principalId: "principal_st",
      accessToken: "identity_st",
      expiresAt: "2099-01-01T00:00:00Z",
    }),
  );
  await connectProvisional();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sync-targets client", () => {
  it("lists targets without secret fields", async () => {
    withSession((url) => {
      if (url.startsWith(`${HOST}/api/v1/sync-targets`)) {
        return jsonResponse({
          sync_targets: [
            {
              id: "sync_target:1",
              project_id: "project:1",
              config_id: "config:prod",
              connection_id: "connection:vercel",
              provider_id: "vercel",
              operation: "env.set",
              status: "ready",
              status_detail: null,
              organization_id: "org:1",
              created_at: "2026-08-17T00:00:00.000Z",
              updated_at: "2026-08-17T00:00:00.000Z",
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    });

    const targets = await listSyncTargets({ projectId: "project:1" });
    expect(targets).toHaveLength(1);
    expect(targets[0]?.providerId).toBe("vercel");
    expect(JSON.stringify(targets)).not.toContain("access_token");
  });

  it("rejects responses with forbidden secret keys", async () => {
    withSession((url) => {
      if (url === `${HOST}/api/v1/sync-targets`) {
        return jsonResponse({
          id: "sync_target:1",
          project_id: "project:1",
          config_id: "config:prod",
          connection_id: "connection:vercel",
          provider_id: "vercel",
          operation: "env.set",
          status: "ready",
          status_detail: null,
          organization_id: "org:1",
          created_at: "2026-08-17T00:00:00.000Z",
          updated_at: "2026-08-17T00:00:00.000Z",
          value: "must-not-appear",
        });
      }
      return jsonResponse({}, 404);
    });

    await expect(
      createSyncTarget({
        projectId: "project:1",
        configId: "config:prod",
        connectionId: "connection:vercel",
      }),
    ).rejects.toThrow(/forbidden key/i);
  });

  it("sync outcome never includes secret values", async () => {
    withSession((url) => {
      if (url.endsWith("/sync")) {
        const target = sampleTarget({
          status: "ready",
          contentVersion: "cv_abc",
        });
        return jsonResponse({
          target: {
            id: target.id,
            project_id: target.projectId,
            config_id: target.configId,
            connection_id: target.connectionId,
            provider_id: target.providerId,
            operation: target.operation,
            status: target.status,
            status_detail: null,
            content_version: "cv_abc",
            organization_id: target.organizationId,
            created_at: target.createdAt,
            updated_at: target.updatedAt,
          },
          ok: true,
          keys_synced: 0,
          content_version: "cv_abc",
        });
      }
      return jsonResponse({}, 404);
    });

    const outcome = await syncTarget("sync_target:1");
    expect(outcome.ok).toBe(true);
    expect(outcome.keysSynced).toBe(0);
    expect(JSON.stringify(outcome)).not.toContain("super-secret");
  });
});

describe("sync-targets errors and filters", () => {
  it("fails listing with the status when Host refuses", async () => {
    withSession((url) => {
      if (url.startsWith(`${HOST}/api/v1/sync-targets`)) {
        return jsonResponse({}, 403);
      }
      return jsonResponse({}, 404);
    });
    await expect(listSyncTargets()).rejects.toThrow(
      /List sync targets failed \(403\)/,
    );
  });

  it("filters by config id and drops non-object rows", async () => {
    const spy = withSession((url) => {
      if (url.startsWith(`${HOST}/api/v1/sync-targets`)) {
        return jsonResponse({
          sync_targets: [
            null,
            "junk",
            {
              id: "sync_target:9",
              projectId: "project:1",
              configId: "config:prod",
              connectionId: "connection:vercel",
              providerId: "vercel",
              operation: "env.set",
              status: "error",
              statusDetail: "upstream refused",
              contentVersion: "cv_1",
              lastSyncedAt: "2026-08-17T01:00:00.000Z",
              organizationId: "org:1",
              createdAt: "2026-08-17T00:00:00.000Z",
              updatedAt: "2026-08-17T01:00:00.000Z",
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    });

    const targets = await listSyncTargets({ configId: "config:prod" });
    const requested = spy.mock.calls.find(([url]) =>
      String(url).startsWith(`${HOST}/api/v1/sync-targets`),
    );
    expect(String(requested?.[0])).toContain("config_id=config%3Aprod");
    expect(targets).toHaveLength(1);
    // camelCase wire variants are accepted too.
    expect(targets[0]).toMatchObject({
      id: "sync_target:9",
      status: "error",
      statusDetail: "upstream refused",
      contentVersion: "cv_1",
      lastSyncedAt: "2026-08-17T01:00:00.000Z",
    });
  });

  it("rejects payloads whose strings look like secret material", async () => {
    const leak = `sk_${"a".repeat(80)}`;
    withSession((url) => {
      if (url.startsWith(`${HOST}/api/v1/sync-targets`)) {
        return jsonResponse({ sync_targets: [], note: leak });
      }
      return jsonResponse({}, 404);
    });
    await expect(listSyncTargets()).rejects.toThrow(/secret material/);
  });

  it("surfaces the hint when creation is refused", async () => {
    withSession((url) => {
      if (url === `${HOST}/api/v1/sync-targets`) {
        return jsonResponse({ hint: "pick a connection first" }, 422);
      }
      return jsonResponse({}, 404);
    });
    await expect(
      createSyncTarget({
        projectId: "project:1",
        configId: "config:prod",
        connectionId: "connection:vercel",
      }),
    ).rejects.toThrow(/pick a connection first/);

    clearHostSession();
    withSession((url) => {
      if (url === `${HOST}/api/v1/sync-targets`) {
        return new Response("nope", { status: 500 });
      }
      return jsonResponse({}, 404);
    });
    await expect(
      createSyncTarget({
        projectId: "project:1",
        configId: "config:prod",
        connectionId: "connection:vercel",
      }),
    ).rejects.toThrow(/Create sync target failed \(500\)/);
  });

  it("creates a target with an explicit operation", async () => {
    const spy = withSession((url) => {
      if (url === `${HOST}/api/v1/sync-targets`) {
        return jsonResponse({
          id: "sync_target:2",
          project_id: "project:1",
          config_id: "config:prod",
          connection_id: "connection:vercel",
          provider_id: "vercel",
          operation: "env.delete",
          status: "idle",
          organization_id: "org:1",
          created_at: "2026-08-17T00:00:00.000Z",
          updated_at: "2026-08-17T00:00:00.000Z",
        });
      }
      return jsonResponse({}, 404);
    });

    const target = await createSyncTarget({
      projectId: "project:1",
      configId: "config:prod",
      connectionId: "connection:vercel",
      operation: "env.delete",
    });
    expect(target.operation).toBe("env.delete");
    const request = spy.mock.calls.find(
      ([url]) => String(url) === `${HOST}/api/v1/sync-targets`,
    );
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      operation: "env.delete",
    });
  });

  it("deletes a target, accepting 200 and 204 but not other failures", async () => {
    const { deleteSyncTarget } = await import("./sync-targets.js");
    withSession((url) => {
      if (url === `${HOST}/api/v1/sync-targets/sync_target%3A1`) {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({}, 404);
    });
    await expect(deleteSyncTarget("sync_target:1")).resolves.toBeUndefined();

    clearHostSession();
    withSession((url) => {
      if (url === `${HOST}/api/v1/sync-targets/sync_target%3A1`) {
        return jsonResponse({}, 500);
      }
      return jsonResponse({}, 404);
    });
    await expect(deleteSyncTarget("sync_target:1")).rejects.toThrow(
      /Delete sync target failed \(500\)/,
    );
  });

  it("syncs selected key names and reports per-target errors", async () => {
    const spy = withSession((url) => {
      if (url.endsWith("/sync")) {
        return jsonResponse({
          target: {
            id: "sync_target:1",
            project_id: "project:1",
            config_id: "config:prod",
            connection_id: "connection:vercel",
            provider_id: "vercel",
            operation: "env.set",
            status: "error",
            organization_id: "org:1",
            created_at: "2026-08-17T00:00:00.000Z",
            updated_at: "2026-08-17T01:00:00.000Z",
          },
          ok: false,
          keysSynced: 2,
          error: "upstream rejected one key",
        });
      }
      return jsonResponse({}, 404);
    });

    const outcome = await syncTarget("sync_target:1", {
      keyNames: ["DATABASE_URL"],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.keysSynced).toBe(2);
    expect(outcome.error).toBe("upstream rejected one key");
    const request = spy.mock.calls.find(([url]) =>
      String(url).endsWith("/sync"),
    );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      key_names: ["DATABASE_URL"],
    });
  });

  it("fails sync calls with the status and rejects targetless outcomes", async () => {
    withSession((url) => {
      if (url.endsWith("/sync")) return jsonResponse({}, 500);
      return jsonResponse({}, 404);
    });
    await expect(syncTarget("sync_target:1")).rejects.toThrow(
      /Sync target failed \(500\)/,
    );

    clearHostSession();
    withSession((url) => {
      if (url.endsWith("/sync")) return jsonResponse({ ok: true });
      return jsonResponse({}, 404);
    });
    await expect(syncTarget("sync_target:1")).rejects.toThrow(/missing target/);
  });

  it("syncs every target of a config through sync-all", async () => {
    const { syncAllForConfig } = await import("./sync-targets.js");
    const spy = withSession((url) => {
      if (url === `${HOST}/api/v1/sync-targets/sync-all`) {
        return jsonResponse({
          outcomes: [
            null,
            {
              target: {
                id: "sync_target:1",
                project_id: "project:1",
                config_id: "config:prod",
                connection_id: "connection:vercel",
                provider_id: "vercel",
                operation: "env.set",
                status: "ready",
                organization_id: "org:1",
                created_at: "2026-08-17T00:00:00.000Z",
                updated_at: "2026-08-17T01:00:00.000Z",
              },
              ok: true,
              keys_synced: 3,
              content_version: "cv_3",
              error: null,
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    });

    const outcomes = await syncAllForConfig("config:prod");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      ok: true,
      keysSynced: 3,
      contentVersion: "cv_3",
      error: null,
    });
    const request = spy.mock.calls.find(([url]) =>
      String(url).endsWith("/sync-all"),
    );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      config_id: "config:prod",
    });

    clearHostSession();
    withSession((url) => {
      if (url.endsWith("/sync-all")) return jsonResponse({}, 500);
      return jsonResponse({}, 404);
    });
    await expect(syncAllForConfig("config:prod")).rejects.toThrow(
      /Sync-all failed \(500\)/,
    );
  });

  it("summarizes a target for the list row", async () => {
    const { formatSyncTargetSummary } = await import("./sync-targets.js");
    expect(formatSyncTargetSummary(sampleTarget())).toBe(
      "vercel · env.set · idle",
    );
    expect(
      formatSyncTargetSummary(
        sampleTarget({ contentVersion: "cv_2", statusDetail: "3 keys" }),
      ),
    ).toBe("vercel · env.set · idle · v cv_2 · 3 keys");
  });
});
