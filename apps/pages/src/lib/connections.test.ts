import {
  type BoundaryValue,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionsError,
  awaitConsent,
  listConnections,
  listProviders,
  refreshConnection,
  setConnectionConfiguration,
  updateConnectionPolicy,
} from "./connections.js";
import {
  HostSessionError,
  clearHostSession,
  clearSession,
  connectProvisional,
  currentSession,
  identityFetch,
} from "./identity.js";
import {
  loadSettings,
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
      // Force Identity device-approval path in unit tests unless a test opts in.
      return jsonResponse({ error: "demo_bootstrap_unavailable" }, 503);
    }
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
    materialization: "deny",
    requested_scopes: ["repo"],
    granted_scopes: ["repo", "read:user"],
    account_label: "acme",
    expires_at: "2026-08-09T00:00:00Z",
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

beforeEach(async () => {
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
  it("drops a bearer before sending to a changed Identity origin", async () => {
    saveSettings({ ...loadSettings(), identityApi: "http://127.0.0.1:19999" });
    const fetch = stubFetch(() => jsonResponse({ error: "unauthorized" }, 401));

    await identityFetch("/v1/principals/me");

    expect(currentSession()).toBeNull();
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.has("authorization")).toBe(false);
  });

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
          connectionWire({
            bindings: [
              {
                id: "binding_1",
                target_kind: "project",
                target_id: "project_1",
                target_label: "Catalog",
                created_at: "2026-08-08T00:00:00Z",
              },
            ],
          }),
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

  it("rejects a connection that violates the strict wire contract", async () => {
    stubHostFetch(() =>
      jsonResponse({ connections: [{ connection_id: "connection_2" }] }),
    );

    await expect(listConnections()).rejects.toThrow(/integration_id/u);
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
            provenance_url: "https://api.slack.com/authentication/oauth-v2",
            catalog_revision: "test.1",
            auth_kind: "oauth2_authorization_code",
            supports_refresh: false,
            configured: false,
            callback_url: null,
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
            integration_configuration_fields: [],
            connection_configuration_fields: [
              {
                name: "workspace",
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
    expect(new Headers(request?.headers).get("authorization")).toBe(
      "Bearer opaque-session:sess_pages",
    );
    expect(request?.credentials).toBe("omit");
  });

  it("sends provider-defined fields as structured configuration", async () => {
    const spy = stubHostFetch(() => jsonResponse(connectionWire()));

    await setConnectionConfiguration("connection_1", {
      service: "opensesame",
    });

    const request = spy.mock.calls.find(([url]) =>
      String(url).endsWith("/connections/connection_1/credential"),
    )?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      configuration_set: { service: "opensesame" },
      configuration_clear: [],
    });
  });

  it("updates connector rules through the connection endpoint", async () => {
    const spy = stubHostFetch(() =>
      jsonResponse(
        connectionWire({
          shareability: "organization_wide",
          max_invoke_level: 1,
        }),
      ),
    );

    const updated = await updateConnectionPolicy("connection_1", {
      shareability: "organization_wide",
      maxInvokeLevel: 1,
    });

    expect(updated.shareability).toBe("organization_wide");
    const request = spy.mock.calls.find(([url]) =>
      String(url).endsWith("/connections/connection_1"),
    )?.[1];
    expect(request?.method).toBe("PATCH");
    expect(JSON.parse(String(request?.body))).toEqual({
      shareability: "organization_wide",
      max_invoke_level: 1,
    });
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

  it("mints an OpenSesame provisional session before Host access", async () => {
    clearSession();
    const spy = stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        return jsonResponse({}, 401);
      }
      if (url === `${IDENTITY}/v1/principals/provisional`) {
        return jsonResponse({
          principalId: "principal_auto",
          accessToken: "identity_auto",
          expiresAt: "2099-01-01T00:00:00Z",
        });
      }
      if (url === `${HOST}/api/v1/session/local`) {
        return jsonResponse({ error: "demo_bootstrap_unavailable" }, 503);
      }
      if (url === `${HOST}/api/v1/device/authorize`) {
        return jsonResponse({
          device_code: "dc_auto",
          user_code: "AUTO-CODE",
        });
      }
      if (url === `${IDENTITY}/v1/device/approve`) {
        return jsonResponse({ ok: true });
      }
      if (url === `${HOST}/api/v1/device/token`) {
        return jsonResponse({
          access_token: "opaque-session:sess_auto",
          expires_in: 28_800,
        });
      }
      if (url === `${HOST}/api/v1/connections`) {
        return jsonResponse({ connections: [] });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });

    await listConnections();

    expect(currentSession()?.accessToken).toBe("identity_auto");
    expect(
      spy.mock.calls.some(
        ([url]) => String(url) === `${IDENTITY}/v1/principals/provisional`,
      ),
    ).toBe(true);
    expect(
      spy.mock.calls.some(
        ([url]) => String(url) === `${HOST}/api/v1/connections`,
      ),
    ).toBe(true);
  });

  it("uses Host-local session without Identity when available", async () => {
    clearSession();
    clearHostSession();
    const spy = stubFetch((url) => {
      if (url === `${HOST}/api/v1/session/local`) {
        return jsonResponse({
          access_token: "opaque-session:sess_local",
          expires_in: 28_800,
          local_session: true,
        });
      }
      if (url === `${HOST}/api/v1/connections`) {
        return jsonResponse({ connections: [] });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });

    await listConnections();

    expect(currentSession()).toBeNull();
    expect(
      spy.mock.calls.some(
        ([url]) => String(url) === `${HOST}/api/v1/session/local`,
      ),
    ).toBe(true);
    expect(
      spy.mock.calls.some(
        ([url]) => String(url) === `${IDENTITY}/v1/principals/provisional`,
      ),
    ).toBe(false);
    const conn = spy.mock.calls.find(
      ([url]) => String(url) === `${HOST}/api/v1/connections`,
    );
    expect(new Headers(conn?.[1]?.headers).get("authorization")).toBe(
      "Bearer opaque-session:sess_local",
    );
  });

  it("classifies an unfinished organization setup as a Host-session gate", async () => {
    clearHostSession();
    stubFetch((url) => {
      if (url === `${HOST}/api/v1/session/local`) {
        return jsonResponse({ error: "demo_bootstrap_unavailable" }, 503);
      }
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
    expect(overlapCast(error).code).toBe("setup_required");
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
    expect(overlapCast(error).code).toBe("not_refreshable");
    expect(overlapCast(error).message).toContain("no refresh token");
  });

  it("reports an unreachable host rather than a bare network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("failed"))),
    );

    const error = await listConnections().catch((caught) => caught);

    expect(overlapCast(error).code).toBe("unreachable");
    expect(overlapCast(error).message).toContain(HOST);
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
      return jsonResponse(
        connectionWire({ status: polls === 1 ? "pending" : "active" }),
      );
    });

    const pending = awaitConsent("connection_1", null);
    await vi.advanceTimersByTimeAsync(5000);

    await expect(pending).resolves.toMatchObject({ result: "active" });
  });

  it("reports failure without pretending it worked", async () => {
    stubWindow();
    vi.useFakeTimers();
    stubHostFetch(() =>
      jsonResponse(
        connectionWire({
          status: "error",
          status_detail: "The provider rejected the code.",
        }),
      ),
    );

    const pending = awaitConsent("connection_1", null);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(pending).resolves.toMatchObject({ result: "failed" });
  });

  it("calls a closed popup over a still-pending connection abandoned", async () => {
    stubWindow();
    vi.useFakeTimers();
    stubHostFetch(() => jsonResponse(connectionWire({ status: "pending" })));

    const pending = awaitConsent("connection_1", overlapCast({ closed: true }));
    await vi.advanceTimersByTimeAsync(5000);

    await expect(pending).resolves.toEqual({ result: "abandoned" });
  });
});

describe("locking", () => {
  it("forgets Host authority with the Identity session, then remints on next Host call", async () => {
    const spy = stubHostFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        return jsonResponse({}, 401);
      }
      if (url === `${IDENTITY}/v1/principals/provisional`) {
        return jsonResponse({
          principalId: "principal_remint",
          accessToken: "identity_remint",
          expiresAt: "2099-01-01T00:00:00Z",
        });
      }
      return jsonResponse({ connections: [] });
    });
    await listConnections();

    clearSession();
    await listConnections();

    expect(currentSession()?.accessToken).toBe("identity_remint");
    expect(
      spy.mock.calls.filter(
        ([url]) => String(url) === `${HOST}/api/v1/connections`,
      ),
    ).toHaveLength(2);
    expect(
      spy.mock.calls.filter(
        ([url]) => String(url) === `${HOST}/api/v1/device/authorize`,
      ),
    ).toHaveLength(2);
  });
});

describe("connection endpoints", () => {
  it("gets, creates, authorizes, and revokes connections", async () => {
    const {
      authorizeConnection,
      createConnection,
      getConnection,
      revokeConnection,
    } = await import("./connections.js");
    const spy = stubHostFetch((url, init) => {
      if (
        url.endsWith("/connections/connection_1") &&
        init?.method === "DELETE"
      ) {
        return jsonResponse({ revoked: true, provider_revocation: "ok" });
      }
      if (url.endsWith("/connections/connection_1/authorize")) {
        return jsonResponse({
          authorization_url: "https://github.com/login/oauth/authorize?x=1",
          state: "state_1",
          expires_at: "2026-08-09T00:00:00Z",
        });
      }
      if (url.endsWith("/connections/connection_1")) {
        return jsonResponse(connectionWire());
      }
      if (url.endsWith("/connections") && init?.method === "POST") {
        return jsonResponse(connectionWire({ display_name: "CI GitHub" }));
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });

    expect((await getConnection("connection_1")).connectionId).toBe(
      "connection_1",
    );

    const created = await createConnection({
      providerId: "github",
      displayName: "CI GitHub",
      scopes: ["repo"],
      projectId: "project_1",
      integrationId: "int_1",
    });
    expect(created.displayName).toBe("CI GitHub");
    const create = spy.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/connections") && init?.method === "POST",
    );
    expect(JSON.parse(String(create?.[1]?.body))).toEqual({
      provider_id: "github",
      display_name: "CI GitHub",
      scopes: ["repo"],
      project_id: "project_1",
      integration_id: "int_1",
    });

    const auth = await authorizeConnection("connection_1", ["repo"]);
    expect(auth.authorizationUrl).toContain("github.com");
    const authorize = spy.mock.calls.find(([url]) =>
      String(url).endsWith("/connections/connection_1/authorize"),
    );
    expect(JSON.parse(String(authorize?.[1]?.body))).toEqual({
      scopes: ["repo"],
    });

    await expect(revokeConnection("connection_1")).resolves.toEqual({
      revoked: true,
      providerRevocation: "ok",
    });
  });

  it("creates a connection with only a provider id", async () => {
    const { createConnection } = await import("./connections.js");
    const spy = stubHostFetch(() => jsonResponse(connectionWire()));
    await createConnection({ providerId: "github" });
    const create = spy.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/connections") && init?.method === "POST",
    );
    expect(JSON.parse(String(create?.[1]?.body))).toEqual({
      provider_id: "github",
    });
  });

  it("sets a raw credential value", async () => {
    const { setConnectionCredential } = await import("./connections.js");
    const spy = stubHostFetch(() => jsonResponse(connectionWire()));
    await setConnectionCredential("connection_1", "sk_live_redacted");
    const request = spy.mock.calls.find(([url]) =>
      String(url).endsWith("/credential"),
    );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      value: "sk_live_redacted",
    });
  });

  it("binds and unbinds agents", async () => {
    const { bindConnection, unbindConnection } = await import(
      "./connections.js"
    );
    const spy = stubHostFetch((url, init) => {
      if (init?.method === "DELETE") {
        return jsonResponse(connectionWire({ bindings: [] }));
      }
      return jsonResponse(
        connectionWire({
          bindings: [
            {
              id: "binding_9",
              target_kind: "agent",
              target_id: "agt_bot",
              target_label: "Release bot",
              created_at: "2026-08-08T00:00:00Z",
            },
          ],
        }),
      );
    });

    const bound = await bindConnection("connection_1", {
      targetKind: "agent",
      targetId: "agt_bot",
      targetLabel: "Release bot",
    });
    expect(bound.bindings[0]?.targetId).toBe("agt_bot");
    const bind = spy.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/bindings") && init?.method === "POST",
    );
    expect(JSON.parse(String(bind?.[1]?.body))).toEqual({
      target_kind: "agent",
      target_id: "agt_bot",
      target_label: "Release bot",
    });

    const unbound = await unbindConnection("connection_1", "binding_9");
    expect(unbound.bindings).toEqual([]);
    const unbind = spy.mock.calls.find(([url]) =>
      String(url).endsWith("/bindings/binding_9"),
    );
    expect(unbind?.[1]?.method).toBe("DELETE");
  });

  it("discovers auto-configured connections and lists events", async () => {
    const { connectionEvents, discoverConnections } = await import(
      "./connections.js"
    );
    stubHostFetch((url) => {
      if (url.endsWith("/connections/discover")) {
        return jsonResponse({ configured: 3 });
      }
      if (url.endsWith("/connections/connection_1/events")) {
        return jsonResponse({
          events: [
            {
              id: "evt_1",
              kind: "authorized",
              at: "2026-08-08T00:00:00Z",
              detail: null,
            },
          ],
        });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });

    await expect(discoverConnections()).resolves.toBe(3);
    await expect(connectionEvents("connection_1")).resolves.toEqual([
      {
        id: "evt_1",
        kind: "authorized",
        at: "2026-08-08T00:00:00Z",
        detail: null,
      },
    ]);
  });

  it("surfaces a non-JSON error body as unknown_error", async () => {
    stubHostFetch(() => new Response("bad gateway", { status: 502 }));
    const error = await listConnections().catch((caught) => caught);
    expect(error).toBeInstanceOf(ConnectionsError);
    expect(overlapCast(error).code).toBe("unknown_error");
    expect(overlapCast(error).status).toBe(502);
  });
});

describe("integrations and GitHub App registration", () => {
  it("lists integrations with only trusted App URLs", async () => {
    const { listIntegrations } = await import("./connections.js");
    stubHostFetch(() =>
      jsonResponse({
        integrations: [
          {
            id: "int_1",
            key: "github-app",
            provider_id: "github",
            display_name: "Acme Backup",
            source: "github_app",
            enabled: true,
            configured: true,
            scopes: ["administration"],
            github_app_html_url: "https://github.com/apps/acme-backup",
          },
          {
            id: "int_2",
            key: "custom",
            provider_id: "gitlab",
            display_name: "Custom",
            source: "catalog",
            enabled: false,
            configured: false,
            scopes: "not-an-array",
            github_app_html_url: "https://evil.example/apps/x",
          },
        ],
      }),
    );

    const rows = await listIntegrations();
    expect(rows[0]?.githubAppHtmlUrl).toBe(
      "https://github.com/apps/acme-backup",
    );
    expect(rows[1]?.githubAppHtmlUrl).toBeNull();
    expect(rows[1]?.scopes).toEqual([]);
  });

  it("starts a GitHub App registration and validates the response", async () => {
    const { startGithubAppRegistration } = await import("./connections.js");
    const spy = stubHostFetch(() =>
      jsonResponse({
        action: "https://github.com/settings/apps/new",
        state: "state_1",
        manifest: { name: "acme-backup" },
        redirect_url: "https://host.example/callback",
      }),
    );

    const registration = await startGithubAppRegistration({
      returnTo: "https://me.github.io/OpenSesame/settings",
      displayName: "Acme Backup",
    });
    expect(registration.manifest).toEqual({ name: "acme-backup" });
    expect(registration.redirectUrl).toBe("https://host.example/callback");
    const request = spy.mock.calls.find(([url]) =>
      String(url).endsWith("/providers/github/app"),
    );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      return_to: "https://me.github.io/OpenSesame/settings",
      display_name: "Acme Backup",
    });

    clearHostSession();
    stubHostFetch(() => jsonResponse({ action: 1 }));
    await expect(
      startGithubAppRegistration({ returnTo: "https://x.example" }),
    ).rejects.toThrow(/invalid GitHub App registration/);
  });
});

describe("compileSecretToHost", () => {
  it("binds only new, non-user grantees for a matching connection", async () => {
    const { compileSecretToHost } = await import("./connections.js");
    const spy = stubHostFetch((url, init) => {
      if (String(url).endsWith("/bindings") && init?.method === "POST") {
        return jsonResponse(connectionWire());
      }
      return jsonResponse({
        connections: [
          connectionWire({
            bindings: [
              {
                id: "binding_1",
                target_kind: "agent",
                target_id: "agt_existing",
                target_label: null,
                created_at: "2026-08-08T00:00:00Z",
              },
            ],
          }),
        ],
      });
    });

    await compileSecretToHost({
      connectionRef: "conn://org/proj/github/main",
      grantees: ["agt_existing", "user:demo", "user:alice", "  ", "agt_new"],
    });

    const binds = spy.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith("/bindings") && init?.method === "POST",
    );
    expect(binds).toHaveLength(1);
    expect(JSON.parse(String(binds[0]?.[1]?.body))).toMatchObject({
      target_kind: "agent",
      target_id: "agt_new",
    });
  });

  it("does nothing without a ref or without a matching connection", async () => {
    const { compileSecretToHost } = await import("./connections.js");
    const spy = stubHostFetch(() =>
      jsonResponse({ connections: [connectionWire()] }),
    );

    await compileSecretToHost({ connectionRef: "", grantees: ["agt_x"] });
    expect(spy).not.toHaveBeenCalled();

    await compileSecretToHost({
      connectionRef: "conn://org/proj/other/main",
      grantees: ["agt_x"],
    });
    expect(
      spy.mock.calls.some(([url]) => String(url).endsWith("/bindings")),
    ).toBe(false);
  });
});
