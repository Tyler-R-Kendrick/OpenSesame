import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCapabilityConnectors } from "./capabilities.js";
import {
  formatChangelogSummary,
  listHostChangelog,
  listHostChangelogPage,
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

function jsonResponse(body: BoundaryValue, status = 200): Response {
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

describe("changelog guards and fallbacks", () => {
  it("refuses Host events carrying forbidden metadata keys", async () => {
    stubHostFetch((url) => {
      if (url.includes("/changelog")) {
        return jsonResponse({
          events: [
            {
              id: "chg_bad",
              event_type: "secret.value.changed",
              occurred_at: "2026-08-17T12:00:00Z",
              metadata: { value: "hunter2" },
            },
          ],
        });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    await expect(listHostChangelog("project_1")).rejects.toThrow(
      /forbidden metadata key/,
    );
  });

  it("fails Host reads with the status and clamps the limit", async () => {
    const spy = stubHostFetch((url) => {
      if (url.includes("/changelog")) return jsonResponse({}, 500);
      return jsonResponse({ error: "unexpected" }, 500);
    });
    await expect(
      listHostChangelog("project_1", { limit: 10_000 }),
    ).rejects.toThrow(/Host changelog failed \(500\)/);
    const request = spy.mock.calls.find(([url]) =>
      String(url).includes("/changelog"),
    );
    expect(String(request?.[0])).toContain("limit=200");
  });

  it("accepts key names from the metadata bag and filters non-strings", async () => {
    stubHostFetch((url) => {
      if (url.includes("/changelog")) {
        return jsonResponse({
          events: [
            null,
            {
              id: "chg_2",
              eventType: "secret.config.updated",
              occurredAt: "2026-08-17T12:05:00Z",
              projectId: "project_1",
              actorId: "principal_1",
              metadata: {
                keyNames: ["API_KEY", 42],
                environment: "staging",
                versionId: "ver_2",
                targetId: "st_1",
                contentVersion: "cv_7",
              },
            },
          ],
        });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });

    const events = await listHostChangelog("project_1", { limit: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "chg_2",
      eventType: "secret.config.updated",
      projectId: "project_1",
      actorId: "principal_1",
      keyNames: ["API_KEY"],
      environment: "staging",
      versionId: "ver_2",
      targetId: "st_1",
      contentVersion: "cv_7",
    });
    const spy = stubHostFetch((url) => {
      if (url.includes("/changelog")) return jsonResponse({ events: [] });
      return jsonResponse({ error: "unexpected" }, 500);
    });
    await listHostChangelog("project_1", { limit: 0 });
    expect(
      String(
        spy.mock.calls.find(([url]) => String(url).includes("/changelog"))?.[0],
      ),
    ).toContain("limit=1");
  });

  it("fails Identity reads with the status", async () => {
    stubFetch((url) => {
      if (url.includes("/v1/audit/events")) return jsonResponse({}, 503);
      return jsonResponse({ error: "unexpected" }, 500);
    });
    await expect(listIdentityChangelog()).rejects.toThrow(
      /Identity changelog failed \(503\)/,
    );
  });

  it("filters Identity events to the requested project", async () => {
    stubFetch((url) => {
      if (url.includes("/v1/audit/events")) {
        return jsonResponse({
          events: [
            {
              id: "evt_a",
              eventType: "secret.config.created",
              occurredAt: "2026-08-17T12:00:00.000Z",
              projectId: "project_1",
              actorId: "principal_1",
              outcome: "succeeded",
            },
            {
              id: "evt_b",
              eventType: "secret.config.deleted",
              occurredAt: "2026-08-17T12:01:00.000Z",
              projectId: "project_2",
            },
          ],
        });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });

    const events = await listIdentityChangelog({ projectId: "project_1" });
    expect(events.map((e) => e.id)).toEqual(["evt_a"]);
    expect(events[0]).toMatchObject({
      actorId: "principal_1",
      outcome: "succeeded",
      metadata: {},
    });
  });

  it("falls back to the Identity audit filter when Host is down", async () => {
    const { listChangelog } = await import("./changelog.js");
    stubHostFetch((url) => {
      if (url.includes("/changelog")) {
        return jsonResponse({ error: "down" }, 500);
      }
      if (url.includes("/v1/audit/events")) {
        return jsonResponse({
          events: [
            {
              id: "evt_fallback",
              eventType: "sync.target.synced",
              occurredAt: "2026-08-17T12:02:00.000Z",
              projectId: "project_1",
              metadata: { targetId: "st_9", contentVersion: "cv_3" },
            },
          ],
        });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });

    const events = await listChangelog({ projectId: "project_1", limit: 5 });
    expect(events.map((e) => e.id)).toEqual(["evt_fallback"]);
  });

  it("queries Identity directly when no project is selected", async () => {
    const { listChangelog } = await import("./changelog.js");
    const spy = stubHostFetch((url) => {
      if (url.includes("/v1/audit/events")) {
        return jsonResponse({ events: [] });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    await expect(listChangelog({ limit: 5 })).resolves.toEqual([]);
    expect(
      spy.mock.calls.some(([url]) => String(url).includes("/changelog")),
    ).toBe(false);
    expect(
      spy.mock.calls.some(([url]) =>
        String(url).includes("/v1/audit/events?changelog=1&limit=5"),
      ),
    ).toBe(true);
  });

  it("pages the durable Host changelog with before_seq / next_before_seq", async () => {
    const spy = stubHostFetch((url) => {
      if (url.includes("/changelog")) {
        const paged = url.includes("before_seq=41");
        return jsonResponse({
          project_id: "project_1",
          events: [
            {
              id: paged ? "chg_older" : "chg_newer",
              seq: paged ? 40 : 41,
              event_type: "secret.value.changed",
              project_id: "project_1",
              key_names: ["API_KEY"],
              occurred_at: "2026-08-17T12:00:00Z",
              metadata: {},
            },
          ],
          next_before_seq: paged ? null : 41,
        });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });

    const first = await listHostChangelogPage("project_1", { limit: 1 });
    expect(first.events.map((e) => e.id)).toEqual(["chg_newer"]);
    expect(first.events[0]?.seq).toBe(41);
    expect(first.nextBeforeSeq).toBe(41);
    expect(
      spy.mock.calls.some(([url]) => String(url).includes("before_seq")),
    ).toBe(false);

    const older = await listHostChangelogPage("project_1", {
      limit: 1,
      beforeSeq: first.nextBeforeSeq ?? 0,
    });
    expect(older.events.map((e) => e.id)).toEqual(["chg_older"]);
    expect(older.nextBeforeSeq).toBeNull();
    expect(
      spy.mock.calls.some(([url]) =>
        String(url).includes("changelog?limit=1&before_seq=41"),
      ),
    ).toBe(true);
  });

  it("composes the full summary line from metadata fallbacks", () => {
    expect(
      formatChangelogSummary({
        id: "1",
        eventType: "secret.value.changed",
        occurredAt: "2026-08-17T12:00:00Z",
        metadata: {
          keyNames: ["A", "B"],
          configId: "cfg_1",
          environment: "production",
          targetId: "st_1",
          contentVersion: "cv_4",
        },
      }),
    ).toBe(
      "secret.value.changed · config cfg_1 · production · keys: A, B · target st_1 · v cv_4",
    );
    expect(
      formatChangelogSummary({
        id: "2",
        eventType: "project.personal.ensured",
        occurredAt: "2026-08-17T12:00:00Z",
        metadata: {},
      }),
    ).toBe("project.personal.ensured");
  });
});
