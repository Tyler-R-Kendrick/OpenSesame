import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCapabilityConnectors } from "./capabilities.js";
import {
  clearHostSession,
  clearSession,
  connectProvisional,
} from "./identity.js";
import {
  createSyncTarget,
  listSyncTargets,
  syncTarget,
  type SyncTarget,
} from "./sync-targets.js";
import {
  saveSettings,
  shippedHostApi,
  shippedIdentityApi,
} from "./settings.js";

const HOST = shippedHostApi;
const IDENTITY = shippedIdentityApi;

function jsonResponse(body: unknown, status = 200): Response {
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
