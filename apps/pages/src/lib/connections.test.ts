import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionsError,
  awaitConsent,
  listConnections,
  listProviders,
  refreshConnection,
} from "./connections.js";
import {
  HostSessionError,
  clearHostSession,
  clearSession,
  connectProvisional,
  currentSession,
  identityFetch,
} from "./identity.js";
import { saveSettings } from "./settings.js";

const HOST = "http://127.0.0.1:8787";
const IDENTITY = "http://127.0.0.1:8788";

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
    if (url === `${HOST}/api/v1/device/authorize`) {
      return jsonResponse({ device_code: "dc_pages", user_code: "ABCD-EFGH" });
    }
    if (url === `${IDENTITY}/v1/device/approve`) {
      return jsonResponse({ ok: true });
    }
    if (url === `${HOST}/api/v1/device/token`) {
      return jsonResponse({
        access_token: "opaque-session:sess_pages",
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
    tursoUrl: "",
  });
  stubFetch((url) => {
    if (url === `${IDENTITY}/v1/principals/me`) {
      return jsonResponse({}, 401);
    }
    return jsonResponse({
      principalId: "principal_pages",
      accessToken: "identity_pages",
      expiresAt: "2099-01-01T00:00:00Z",
    });
  });
  await connectProvisional();
  vi.unstubAllGlobals();
});

afterEach(() => {
  clearSession();
  clearHostSession();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Identity cookie resume", () => {
  it("keeps the same principal without exposing or replacing its bearer", async () => {
    clearSession();
    const fetch = stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        return jsonResponse({ id: "principal_existing" });
      }
      if (url === `${IDENTITY}/v1/device/approve`)
        return jsonResponse({ ok: true });
      return jsonResponse({ error: "unexpected" }, 500);
    });

    await connectProvisional();
    await identityFetch("/v1/device/approve", { method: "POST", body: "{}" });

    expect(currentSession()).toMatchObject({
      principalId: "principal_existing",
      cookieOnly: true,
    });
    expect(fetch).not.toHaveBeenCalledWith(
      `${IDENTITY}/v1/principals/provisional`,
      expect.anything(),
    );
    const approve = fetch.mock.calls.find(
      ([url]) => String(url) === `${IDENTITY}/v1/device/approve`,
    );
    expect(new Headers(approve?.[1]?.headers).has("authorization")).toBe(false);
    expect(approve?.[1]?.credentials).toBe("include");
  });
});

describe("reading connections", () => {
  it("maps the wire shape onto the view model", async () => {
    stubHostFetch(() =>
      jsonResponse({
        connections: [
          {
            connection_id: "connection_1",
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
            requested_scopes: ["repo"],
            granted_scopes: ["repo", "read:user"],
            account_label: "acme",
            expires_at: "2026-08-09T00:00:00Z",
            refreshable: true,
            last_refreshed_at: null,
            max_invoke_level: 2,
            egress: {
              scheme: "https",
              authorities: ["api.github.com"],
              path_prefixes: [],
            },
            bindings: [
              {
                id: "binding_1",
                target_kind: "project",
                target_id: "project_1",
                target_label: "Catalog",
                created_at: "2026-08-08T00:00:00Z",
              },
            ],
            created_at: "2026-08-08T00:00:00Z",
            updated_at: "2026-08-08T00:00:00Z",
          },
        ],
      }),
    );

    const [connection] = await listConnections();

    expect(connection?.connectionId).toBe("connection_1");
    expect(connection?.grantedScopes).toEqual(["repo", "read:user"]);
    expect(connection?.refreshable).toBe(true);
    expect(connection?.egress.authorities).toEqual(["api.github.com"]);
    expect(connection?.bindings[0]?.targetLabel).toBe("Catalog");
  });

  it("survives a connection missing optional fields", async () => {
    stubHostFetch(() =>
      jsonResponse({ connections: [{ connection_id: "connection_2" }] }),
    );

    const [connection] = await listConnections();

    expect(connection?.accountLabel).toBeNull();
    expect(connection?.expiresAt).toBeNull();
    expect(connection?.bindings).toEqual([]);
    expect(connection?.refreshable).toBe(false);
  });

  it("maps a provider including what the deployment is missing", async () => {
    const spy = stubHostFetch(() =>
      jsonResponse({
        providers: [
          {
            id: "slack",
            display_name: "Slack",
            category: "communication",
            docs_url: "https://api.slack.com/authentication/oauth-v2",
            auth_kind: "oauth2_authorization_code",
            supports_refresh: false,
            configured: false,
            missing_config: [
              "OPENSESAME_PROVIDER_SLACK_CLIENT_ID",
              "OPENSESAME_PROVIDER_SLACK_CLIENT_SECRET",
            ],
            scopes: [
              {
                name: "chat:write",
                description: "Post messages as the app",
                sensitive: false,
                default: true,
              },
            ],
            egress: {
              scheme: "https",
              authorities: ["slack.com"],
              path_prefixes: [],
            },
            operations: [],
            configuration_fields: [
              {
                name: "workspace",
                label: "Workspace",
                secret: false,
                required: true,
              },
            ],
          },
        ],
      }),
    );

    const [provider] = await listProviders();

    expect(provider?.configured).toBe(false);
    expect(provider?.missingConfig).toHaveLength(2);
    expect(provider?.scopes[0]?.default).toBe(true);
    expect(provider?.configurationFields?.[0]?.label).toBe("Workspace");
    const request = spy.mock.calls.find(
      ([url]) => String(url) === `${HOST}/api/v1/providers`,
    )?.[1];
    expect(new Headers(request?.headers).has("authorization")).toBe(false);
    expect(request?.credentials).toBe("omit");
  });
});

describe("transport", () => {
  it("mints and reuses a user-scoped Host session", async () => {
    const spy = stubHostFetch(() => jsonResponse({ connections: [] }));

    await listConnections();
    await listConnections();

    const approve = spy.mock.calls.find(
      ([url]) => String(url) === `${IDENTITY}/v1/device/approve`,
    );
    expect(new Headers(approve?.[1]?.headers).get("authorization")).toBe(
      "Bearer identity_pages",
    );
    const requests = spy.mock.calls.filter(
      ([url]) => String(url) === `${HOST}/api/v1/connections`,
    );
    expect(requests).toHaveLength(2);
    const init = requests[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer opaque-session:sess_pages",
    );
    // A cookie from the Identity plane must not answer for the Host plane.
    expect(init?.credentials).toBe("omit");
    expect(
      spy.mock.calls.filter(
        ([url]) => String(url) === `${HOST}/api/v1/device/authorize`,
      ),
    ).toHaveLength(1);
  });

  it("refuses Host access without an Identity session", async () => {
    clearSession();
    const spy = stubFetch(() => jsonResponse({ connections: [] }));

    const error = await listConnections().catch((caught) => caught);

    expect((error as Error).message).toContain("Connect to Identity");
    expect(spy).not.toHaveBeenCalled();
  });

  it("classifies an unfinished organization setup as a Host-session gate", async () => {
    clearHostSession();
    stubFetch((url) => {
      if (url === `${HOST}/api/v1/device/authorize`) {
        return jsonResponse({
          device_code: "dc_pages",
          user_code: "ABCD-EFGH",
        });
      }
      if (url === `${IDENTITY}/v1/device/approve`) {
        return jsonResponse({ hint: "Select one of your organizations" }, 400);
      }
      return jsonResponse({}, 500);
    });

    const error = await listConnections().catch((caught) => caught);

    expect(error).toBeInstanceOf(HostSessionError);
    expect((error as HostSessionError).code).toBe("setup_required");
  });

  it("surfaces the API error code and hint", async () => {
    stubHostFetch(() =>
      jsonResponse(
        {
          error: "not_refreshable",
          hint: "This provider issues no refresh token.",
        },
        409,
      ),
    );

    const error = await refreshConnection("connection_1").catch(
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(ConnectionsError);
    expect((error as ConnectionsError).code).toBe("not_refreshable");
    expect((error as ConnectionsError).message).toContain("no refresh token");
  });

  it("reports an unreachable host rather than a bare network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("failed"))),
    );

    const error = await listConnections().catch((caught) => caught);

    expect((error as ConnectionsError).code).toBe("unreachable");
    expect((error as ConnectionsError).message).toContain(HOST);
  });
});

describe("awaiting consent", () => {
  /** `awaitConsent` listens on window; the node test environment has none. */
  function stubWindow() {
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  }

  it("settles active once the connection stops being pending", async () => {
    stubWindow();
    vi.useFakeTimers();
    let polls = 0;
    stubHostFetch(() => {
      polls += 1;
      return jsonResponse({
        connection_id: "connection_1",
        status: polls === 1 ? "pending" : "active",
        account_label: "acme",
      });
    });

    const pending = awaitConsent("connection_1", null);
    await vi.advanceTimersByTimeAsync(5000);

    await expect(pending).resolves.toMatchObject({ result: "active" });
  });

  it("reports failure without pretending it worked", async () => {
    stubWindow();
    vi.useFakeTimers();
    stubHostFetch(() =>
      jsonResponse({
        connection_id: "connection_1",
        status: "error",
        status_detail: "The provider rejected the code.",
      }),
    );

    const pending = awaitConsent("connection_1", null);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(pending).resolves.toMatchObject({ result: "failed" });
  });

  it("calls a closed popup over a still-pending connection abandoned", async () => {
    stubWindow();
    vi.useFakeTimers();
    stubHostFetch(() =>
      jsonResponse({ connection_id: "connection_1", status: "pending" }),
    );

    const pending = awaitConsent("connection_1", { closed: true } as Window);
    await vi.advanceTimersByTimeAsync(5000);

    await expect(pending).resolves.toEqual({ result: "abandoned" });
  });
});

describe("locking", () => {
  it("forgets Host authority with the Identity session", async () => {
    const spy = stubHostFetch(() => jsonResponse({ connections: [] }));
    await listConnections();

    clearSession();
    await expect(listConnections()).rejects.toThrow("Connect to Identity");
    expect(
      spy.mock.calls.filter(
        ([url]) => String(url) === `${HOST}/api/v1/connections`,
      ),
    ).toHaveLength(1);
  });
});
