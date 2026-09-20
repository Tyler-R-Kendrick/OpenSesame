import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCapabilityConnectors } from "./capabilities.js";
import {
  formatChangelogSummary,
  listChangelog,
  listIdentityChangelog,
} from "./changelog.js";
import { clearSession, connectProvisional } from "./identity.js";
import { saveSettings } from "./settings.js";

const IDENTITY = "https://identity.example.test";

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

beforeEach(async () => {
  clearSession();
  saveSettings({
    hostApi: "",
    identityApi: IDENTITY,
    daemonApi: "",
    mfaAppUrl: "",
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
});

describe("changelog client", () => {
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

  it("formats a read-only summary line", async () => {
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

  it("lists through listChangelog without a project", async () => {
    stubFetch((url) => {
      if (url.includes("/v1/audit/events")) {
        return jsonResponse({ events: [] });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    await expect(listChangelog({ limit: 5 })).resolves.toEqual([]);
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
