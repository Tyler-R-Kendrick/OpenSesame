import { describe, expect, it, vi } from "vitest";
import {
  DirectoryError,
  listDirectory,
  normalizeDirectoryEndpoint,
  parseConnections,
  parseIntegrations,
} from "./nango-directory.js";

function reply(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
  } as unknown as Response;
}

function server(routes: Record<string, () => Response>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const handler = routes[path];
    if (!handler) return reply(404, { error: { code: "not_found" } });
    return handler();
  }) as unknown as typeof fetch;
}

describe("the endpoint rule", () => {
  it("keeps https anywhere and http on loopback, without a trailing slash", () => {
    expect(normalizeDirectoryEndpoint("https://api.nango.dev/")).toBe(
      "https://api.nango.dev",
    );
    expect(normalizeDirectoryEndpoint("http://localhost:3003")).toBe(
      "http://localhost:3003",
    );
    expect(normalizeDirectoryEndpoint("http://nango.internal:3003")).toBeNull();
    expect(normalizeDirectoryEndpoint("https://u:p@api.nango.dev")).toBeNull();
    expect(normalizeDirectoryEndpoint("not a url")).toBeNull();
    expect(normalizeDirectoryEndpoint("   ")).toBeNull();
  });
});

describe("reading the listing", () => {
  it("reads today's shapes and names each connection after its integration", () => {
    const integrations = parseIntegrations({
      data: [
        {
          unique_key: "github-prod",
          provider: "github",
          display_name: "GitHub",
        },
        { unique_key: "slack", provider: "slack" },
      ],
    });
    expect(integrations).toEqual([
      { id: "github-prod", provider: "github", displayName: "GitHub" },
      { id: "slack", provider: "slack", displayName: "slack" },
    ]);
    const connections = parseConnections(
      {
        connections: [
          {
            id: 18393,
            connection_id: "octocat",
            provider_config_key: "github-prod",
            provider: "github",
            created: "2026-09-01T00:00:00Z",
            errors: [{ type: "auth" }],
            end_user: { id: "u1", email: "octo@example.com" },
          },
          { connection_id: "", provider_config_key: "slack" },
        ],
      },
      integrations,
    );
    expect(connections).toEqual([
      {
        id: "18393",
        connectionId: "octocat",
        integrationId: "github-prod",
        provider: "github",
        displayName: "GitHub",
        endUser: "octo@example.com",
        createdAt: "2026-09-01T00:00:00Z",
        errors: 1,
      },
    ]);
  });

  it("reads the older shapes too", () => {
    expect(
      parseIntegrations({
        configs: [{ unique_key: "hubspot", provider: "hubspot" }],
      }),
    ).toEqual([{ id: "hubspot", provider: "hubspot", displayName: "hubspot" }]);
    expect(
      parseConnections(
        {
          connections: [
            { connection_id: "c1", provider_config_key: "hubspot" },
          ],
        },
        [],
      ),
    ).toEqual([
      {
        id: "",
        connectionId: "c1",
        integrationId: "hubspot",
        provider: "hubspot",
        displayName: "hubspot",
        endUser: null,
        createdAt: null,
        errors: 0,
      },
    ]);
  });

  it("drops anything that is not a listing row, credentials included", () => {
    const [row] = parseConnections(
      {
        connections: [
          {
            connection_id: "c1",
            provider_config_key: "github",
            credentials: { access_token: "gho_secret" },
          },
        ],
      },
      [],
    );
    expect(JSON.stringify(row)).not.toContain("gho_secret");
    expect(parseConnections("nope", [])).toEqual([]);
    expect(parseIntegrations(null)).toEqual([]);
  });
});

describe("the two calls", () => {
  it("sends the key as a bearer token and falls back to the older path", async () => {
    const fetchImpl = server({
      "/integrations": () =>
        reply(200, { data: [{ unique_key: "github", provider: "github" }] }),
      "/connection": () =>
        reply(200, {
          connections: [{ connection_id: "c1", provider_config_key: "github" }],
        }),
    });
    const listing = await listDirectory(
      "https://api.nango.dev",
      "sk-env",
      fetchImpl,
    );
    expect(listing.connections.map((row) => row.connectionId)).toEqual(["c1"]);
    const calls = vi.mocked(fetchImpl).mock.calls;
    expect(calls.map(([url]) => String(url))).toEqual([
      "https://api.nango.dev/integrations",
      "https://api.nango.dev/connections",
      "https://api.nango.dev/connection",
    ]);
    const init = calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer sk-env",
    );
    expect(init.credentials).toBe("omit");
  });

  it("sends no authorization header without a key", async () => {
    const fetchImpl = server({
      "/integrations": () => reply(200, { data: [] }),
      "/connections": () => reply(200, { connections: [] }),
    });
    await listDirectory("http://localhost:3003", "", fetchImpl);
    const init = vi.mocked(fetchImpl).mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("says the key was refused, not that the endpoint is broken", async () => {
    const fetchImpl = server({
      "/integrations": () => reply(401, { error: { code: "unauthorized" } }),
    });
    await expect(
      listDirectory("https://api.nango.dev", "bad", fetchImpl),
    ).rejects.toMatchObject({ failure: "refused" });
  });

  it("says when the endpoint did not answer at all", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(
      listDirectory("https://api.nango.dev", "k", fetchImpl),
    ).rejects.toBeInstanceOf(DirectoryError);
    await expect(
      listDirectory("https://api.nango.dev", "k", fetchImpl),
    ).rejects.toMatchObject({ failure: "unanswered" });
  });

  it("refuses an endpoint this page may not call before any request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      listDirectory("http://nango.internal", "k", fetchImpl),
    ).rejects.toMatchObject({ failure: "malformed" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
