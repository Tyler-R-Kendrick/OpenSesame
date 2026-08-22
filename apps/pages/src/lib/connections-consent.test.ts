import {
  type BoundaryValue,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionsError,
  awaitConsent,
  openConsentPopup,
  submitGithubAppManifest,
} from "./connections.js";
import { clearHostSession, clearSession } from "./identity.js";
import {
  saveSettings,
  shippedHostApi,
  shippedIdentityApi,
} from "./settings.js";

const HOST = shippedHostApi;
const IDENTITY = shippedIdentityApi;
const HOST_ORIGIN = new URL(HOST).origin;

function jsonResponse(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function connectionWire(overrides: JsonObject = {}) {
  return {
    connection_id: "connection_1",
    integration_id: null,
    connection_ref: "conn://org/proj/github/main",
    logical_name: "github/main",
    display_name: "GitHub — acme",
    provider_id: "github",
    status: "active",
    status_detail: null,
    organization_id: "organization_1",
    project_id: null,
    owner_kind: "organization",
    shareability: "delegable",
    requested_scopes: [],
    granted_scopes: [],
    account_label: "acme",
    expires_at: null,
    refreshable: true,
    configured_fields: [],
    last_refreshed_at: null,
    max_invoke_level: 2,
    egress: {
      scheme: "https",
      authorities: ["api.github.com"],
      path_prefixes: [],
    },
    bindings: [],
    created_at: "2026-08-08T00:00:00Z",
    updated_at: "2026-08-08T00:00:00Z",
    ...overrides,
  };
}

/** Host-local session mint + the connection poll endpoint. */
function stubHost(poll: (url: string) => Response) {
  const spy = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${HOST}/api/v1/session/local`) {
      return Promise.resolve(
        jsonResponse({
          access_token: "opaque-session:sess_consent",
          expires_in: 28_800,
          local_session: true,
        }),
      );
    }
    return Promise.resolve(poll(url));
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

beforeEach(() => {
  clearSession();
  clearHostSession();
  saveSettings({
    hostApi: HOST,
    identityApi: IDENTITY,
    daemonApi: "http://127.0.0.1:18790",
    tursoUrl: "",
    mfaAppUrl: "",
    capabilityConnectors: {
      encryption: { providerId: "webcrypto" },
      history: { providerId: "github" },
    },
  });
});

afterEach(() => {
  clearSession();
  clearHostSession();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("submitGithubAppManifest", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("posts the manifest to GitHub in this tab", () => {
    const submit = vi
      .spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(() => {});

    submitGithubAppManifest({
      action: "https://github.com/settings/apps/new",
      state: "state 1",
      manifest: { name: "acme-backup" },
      redirectUrl: "https://host.example/callback",
    });

    expect(submit).toHaveBeenCalledOnce();
    const form = document.body.querySelector("form");
    expect(form?.method).toBe("post");
    expect(form?.action).toBe(
      "https://github.com/settings/apps/new?state=state%201",
    );
    expect(form?.target).toBe("_self");
    const input = form?.querySelector("input");
    expect(input?.name).toBe("manifest");
    expect(JSON.parse(input?.value ?? "")).toEqual({ name: "acme-backup" });
  });

  it("refuses a registration URL that is not github.com", () => {
    expect(() =>
      submitGithubAppManifest({
        action: "https://evil.example/settings/apps/new",
        state: "s",
        manifest: {},
        redirectUrl: "",
      }),
    ).toThrowError(ConnectionsError);
    expect(document.body.querySelector("form")).toBeNull();
  });
});

describe("openConsentPopup", () => {
  it("opens the named consent window", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const popup = openConsentPopup("https://host.example/authorize");
    expect(popup).toBeNull();
    expect(open).toHaveBeenCalledWith(
      "https://host.example/authorize",
      "opensesame-connect",
      expect.stringContaining("width=680"),
    );
  });
});

describe("awaitConsent message flow", () => {
  function postMessage(data: BoundaryValue, origin = HOST_ORIGIN) {
    const event = new MessageEvent("message", { data, origin });
    window.dispatchEvent(event);
  }

  it("ignores messages from other origins, types, and connections", async () => {
    vi.useFakeTimers();
    let polls = 0;
    stubHost(() => {
      polls += 1;
      return jsonResponse(
        connectionWire({ status: polls < 3 ? "pending" : "active" }),
      );
    });

    const pending = awaitConsent("connection_1", null);
    // Let the first poll land, then fire off noise that must be ignored.
    await vi.advanceTimersByTimeAsync(1600);
    postMessage(
      { type: "opensesame:connection", connectionId: "connection_1" },
      "https://evil.example",
    );
    postMessage({ type: "other:message", connectionId: "connection_1" });
    postMessage({
      type: "opensesame:connection",
      connectionId: "connection_2",
    });
    postMessage("not an object");
    await vi.advanceTimersByTimeAsync(1600);
    postMessage({
      type: "opensesame:connection",
      connectionId: "connection_1",
    });
    await vi.advanceTimersByTimeAsync(3200);

    await expect(pending).resolves.toMatchObject({ result: "active" });
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  it("resolves abandoned when the caller aborts", async () => {
    vi.useFakeTimers();
    stubHost(() => jsonResponse(connectionWire({ status: "pending" })));
    const controller = new AbortController();

    const pending = awaitConsent("connection_1", null, controller.signal);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1600);

    await expect(pending).resolves.toEqual({ result: "abandoned" });
  });

  it("keeps polling when a status read fails", async () => {
    vi.useFakeTimers();
    let polls = 0;
    stubHost(() => {
      polls += 1;
      if (polls === 1) return jsonResponse({ error: "boom" }, 500);
      return jsonResponse(connectionWire({ status: "active" }));
    });

    const pending = awaitConsent("connection_1", null);
    await vi.advanceTimersByTimeAsync(5000);

    await expect(pending).resolves.toMatchObject({ result: "active" });
  });

  it("gives a closed popup one last poll that can still land active", async () => {
    vi.useFakeTimers();
    let polls = 0;
    stubHost(() => {
      polls += 1;
      return jsonResponse(
        connectionWire({ status: polls < 2 ? "pending" : "active" }),
      );
    });

    const pending = awaitConsent("connection_1", overlapCast({ closed: true }));
    await vi.advanceTimersByTimeAsync(5000);

    await expect(pending).resolves.toMatchObject({ result: "active" });
    expect(polls).toBeGreaterThanOrEqual(2);
  });
});
