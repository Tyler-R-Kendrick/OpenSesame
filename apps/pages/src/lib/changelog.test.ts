import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCapabilityConnectors } from "./capabilities.js";
import {
  formatChangelogSummary,
  listHostChangelog,
  listIdentityChangelog,
} from "./changelog.js";
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

const HOST = shippedHostApi;
const IDENTITY = shippedIdentityApi;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

function stubHostFetch(handler: (url: string, init?: RequestInit) => Response) {
  return stubFetch((url, init) => {
    if (url === `${HOST}/api/v1/session/local`) {
      return jsonResponse({ error: "demo_bootstrap_unavailable" }, 503);
    }
    if (url === `${HOST}/api/v1/device/authorize`) {
      return jsonResponse({ device_code: "dc_chg", user_code: "ABCD-EFGH" });
    }
    if (url === `${IDENTITY}/v1/device/approve`) {
      return jsonResponse({ ok: true });
    }
    if (url === `${HOST}/api/v1/device/token`) {
      return jsonResponse({
        access_token: "opaque-session:sess_chg",
        expires_in: 28_800,
      });
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
  stubFetch((url) => {
    if (url === `${IDENTITY}/v1/principals/me`) {
      return jsonResponse({}, 401);
    }
    return jsonResponse({
      principalId: "principal_chg",
      accessToken: "identity_chg",
      expiresAt: "2099-01-01T00:00:00Z",
    });
  });
  await connectProvisional();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearSession();
  clearHostSession();
});

describe("changelog client", () => {
  it("lists Host changelog metadata without secret values", async () => {
    stubHostFetch((url) => {
      if (url.includes("/api/v1/projects/project_1/changelog")) {
        return jsonResponse({
          project_id: "project_1",
          events: [
            {
              id: "chg_1",
              event_type: "secret.value.changed",
              project_id: "project_1",
              config_id: "cfg_api",
              environment: "production",
              key_names: ["DATABASE_URL"],
              version_id: "ver_1",
              occurred_at: "2026-08-17T12:00:00Z",
              metadata: {
                configId: "cfg_api",
                keyNames: ["DATABASE_URL"],
              },
            },
          ],
        });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });

    const events = await listHostChangelog("project_1");
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("secret.value.changed");
    expect(events[0]?.keyNames).toEqual(["DATABASE_URL"]);
    expect(JSON.stringify(events)).not.toMatch(/password|hunter|secret_value/i);
  });

  it("lists Identity changelog via audit filter", async () => {
    stubFetch((url) => {
      if (url.includes("/v1/audit/events?changelog=1")) {
        return jsonResponse({
          events: [
            {
              id: "evt_1",
              occurredAt: "2026-08-17T12:00:00.000Z",
              eventType: "secret.config.created",
              outcome: "succeeded",
              correlationId: "cor_1",
              projectId: "project_1",
              metadata: { configId: "cfg_1", environment: "staging" },
            },
            {
              id: "evt_noise",
              occurredAt: "2026-08-17T12:01:00.000Z",
              eventType: "organization.created",
              outcome: "succeeded",
              correlationId: "cor_2",
              metadata: {},
            },
          ],
        });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });

    const events = await listIdentityChangelog({ projectId: "project_1" });
    expect(events.map((e) => e.eventType)).toEqual(["secret.config.created"]);
  });

  it("formats a read-only summary line", () => {
    expect(
      formatChangelogSummary({
        id: "1",
        eventType: "sync.target.synced",
        occurredAt: "2026-08-17T12:00:00Z",
        targetId: "st_1",
        contentVersion: "cv_9",
        metadata: {},
      }),
    ).toContain("sync.target.synced");
  });
});
