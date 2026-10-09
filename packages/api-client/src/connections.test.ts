import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createApiClient } from "./index.js";

const egress = {
  scheme: "https",
  authorities: ["api.github.com"],
  path_prefixes: [],
};

const connection = {
  connection_id: "connection_01J",
  integration_id: "integration_01J",
  connection_ref: "conn://acme/web/github/main",
  logical_name: "github/main",
  display_name: "GitHub — acme",
  provider_id: "github",
  status: "active",
  status_detail: null,
  organization_id: "organization_01J",
  project_id: null,
  owner_kind: "organization",
  shareability: "private",
  materialization: "deny",
  requested_scopes: ["repo"],
  granted_scopes: ["repo"],
  account_label: "acme",
  expires_at: "2026-08-08T11:00:00.000Z",
  refreshable: true,
  last_refreshed_at: null,
  max_invoke_level: 2,
  egress,
  bindings: [],
  created_at: "2026-08-08T10:00:00.000Z",
  updated_at: "2026-08-08T10:00:00.000Z",
};

const integration = {
  id: "integration_01J",
  key: "engineering",
  provider_id: "github",
  display_name: "Engineering GitHub",
  source: "organization",
  enabled: true,
  configured: true,
  callback_url: "https://host.test:8787/api/v1/oauth/callback/github",
  scopes: ["read:user"],
  client_id_hint: "***1234",
  has_client_secret: true,
  connection_count: 0,
  created_by: "principal:admin",
  created_at: "2026-08-08T10:00:00.000Z",
  updated_at: "2026-08-08T10:00:00.000Z",
};

function jsonClient(
  handler: (url: string, init?: RequestInit) => Response,
  calls: { url: string; method: string; body: string }[] = [],
) {
  return {
    calls,
    client: createApiClient({
      baseUrl: "https://host.test:8787",
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          method: String(init?.method ?? "GET"),
          body: String(init?.body ?? ""),
        });
        return handler(String(input), init);
      },
    }),
  };
}

function ok(body: BoundaryValue): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("api-client connections", () => {
  it("discovers Host credentials without receiving their values", async () => {
    const { client, calls } = jsonClient(() => ok({ configured: 2 }));
    await expect(client.discoverConnections()).resolves.toEqual({
      configured: 2,
    });
    expect(calls[0]).toMatchObject({
      url: "https://host.test:8787/api/v1/connections/discover",
      method: "POST",
    });
  });

  it("parses a connection list", async () => {
    const { client } = jsonClient(() => ok({ connections: [connection] }));
    const res = await client.listConnections();
    expect(res.connections[0]?.connection_ref).toBe(
      "conn://acme/web/github/main",
    );
  });

  it("parses the provider catalog", async () => {
    const { client, calls } = jsonClient(() =>
      ok({
        providers: [
          {
            id: "github",
            display_name: "GitHub",
            category: "developer",
            docs_url: "https://docs.github.com/apps/oauth-apps",
            provenance_url: "https://docs.github.com/apps/oauth-apps",
            catalog_revision: "2026-08-10.1",
            auth_kind: "oauth2_authorization_code",
            supports_refresh: true,
            configured: false,
            callback_url: "https://host.test:8787/api/v1/oauth/callback/github",
            missing_config: ["OPENSESAME_PROVIDER_GITHUB_CLIENT_ID"],
            scopes: [],
            egress,
            operations: [],
          },
        ],
      }),
    );
    const res = await client.listProviders();
    expect(res.providers[0]?.configured).toBe(false);
    expect(calls[0]?.url).toBe("https://host.test:8787/api/v1/providers");
  });

  it("manages safe integration metadata", async () => {
    const { client, calls } = jsonClient((url, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url.endsWith("/integrations")) {
        return init?.method === "POST"
          ? ok(integration)
          : ok({ integrations: [integration] });
      }
      return ok(integration);
    });
    expect((await client.listIntegrations()).integrations).toHaveLength(1);
    expect((await client.getIntegration("integration_01J")).key).toBe(
      "engineering",
    );
    await client.createIntegration({
      key: "engineering",
      provider_id: "github",
      display_name: "Engineering GitHub",
      client_secret: "write-only",
    });
    await client.updateIntegration("integration_01J", {
      display_name: "Engineering",
    });
    await client.deleteIntegration("integration_01J");
    expect(calls[3]?.body).not.toContain("client_secret");
    expect(calls[4]?.method).toBe("DELETE");
  });

  it("posts create, authorize, credential and binding bodies", async () => {
    const { client, calls } = jsonClient((url) =>
      url.endsWith("/authorize")
        ? ok({
            authorization_url: "https://github.com/login/oauth/authorize?x=1",
            state: "state_01J",
            expires_at: "2026-08-08T10:10:00.000Z",
          })
        : ok(connection),
    );

    await client.createConnection({
      integration_id: "integration_01J",
      provider_id: "github",
      scopes: ["repo"],
    });
    const auth = await client.authorizeConnection("connection_01J");
    await client.setConnectionCredential("connection_01J", "key_live");
    await client.bindConnection("connection_01J", {
      target_kind: "agent",
      target_id: "agent_01J",
    });

    expect(auth.state).toBe("state_01J");
    expect(calls[0]?.body).toContain('"provider_id":"github"');
    expect(calls[1]?.url).toBe(
      "https://host.test:8787/api/v1/connections/connection_01J/authorize",
    );
    expect(calls[2]?.body).toBe('{"value":"key_live"}');
    expect(calls[3]?.body).toContain('"target_kind":"agent"');
  });

  it("refreshes, revokes, unbinds and reads events", async () => {
    const { client, calls } = jsonClient((url, init) => {
      if (init?.method === "DELETE" && url.endsWith("/connection_01J")) {
        return ok({ revoked: true, provider_revocation: "unsupported" });
      }
      if (url.endsWith("/events")) {
        return ok({
          events: [
            {
              id: "event_01J",
              kind: "refreshed",
              at: "2026-08-08T10:00:02.000Z",
              detail: null,
            },
          ],
        });
      }
      return ok(connection);
    });

    expect((await client.refreshConnection("connection_01J")).status).toBe(
      "active",
    );
    expect((await client.getConnection("connection_01J")).provider_id).toBe(
      "github",
    );
    expect(
      (await client.unbindConnection("connection_01J", "binding_01J"))
        .connection_id,
    ).toBe("connection_01J");
    expect(
      (await client.connectionEvents("connection_01J")).events[0]?.kind,
    ).toBe("refreshed");
    const revoked = await client.revokeConnection("connection_01J");
    expect(revoked.provider_revocation).toBe("unsupported");
    expect(calls[2]?.url).toBe(
      "https://host.test:8787/api/v1/connections/connection_01J/bindings/binding_01J",
    );
    expect(calls[4]?.method).toBe("DELETE");
  });

  it("surfaces the broker error code from an {error, hint} body", async () => {
    const { client } = jsonClient(
      () =>
        new Response(
          JSON.stringify({
            error: "provider_unconfigured",
            hint: "Set OPENSESAME_PROVIDER_GITHUB_CLIENT_ID.",
          }),
          { status: 409 },
        ),
    );
    await expect(
      client.createConnection({
        integration_id: "integration_01J",
        provider_id: "github",
      }),
    ).rejects.toThrow("connection_create_failed:409:provider_unconfigured");
  });

  it("falls back to the status when the error body is not JSON", async () => {
    const { client } = jsonClient(() => new Response("nope", { status: 502 }));
    await expect(client.listConnections()).rejects.toThrow(
      "connections_failed:502",
    );
  });

  it("fails loudly when a response carries token material", async () => {
    const { client } = jsonClient(() =>
      ok({ connections: [{ ...connection, access_token: "at_live" }] }),
    );
    await expect(client.listConnections()).rejects.toThrow();
  });
});
