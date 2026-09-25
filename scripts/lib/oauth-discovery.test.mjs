import { describe, expect, it } from "vitest";
import {
  discoverAuthorizationServer,
  discoverProtectedResource,
  summarizeServerMetadata,
  wellKnownUrls,
} from "./oauth-discovery.mjs";

/** A `fetchJson` that answers from a fixed table of well-known documents. */
function documents(table) {
  const asked = [];
  const fetchJson = async (url) => {
    asked.push(url);
    return url in table
      ? { ok: true, status: 200, body: table[url] }
      : { ok: false, status: 404 };
  };
  return { fetchJson, asked };
}

const AS = {
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
  registration_endpoint: "https://auth.example.com/register",
  code_challenge_methods_supported: ["S256", "bogus"],
  scopes_supported: ["read", "write"],
};

describe("OAuth discovery", () => {
  it("inserts the well-known segment before a path (RFC 9728 §3.1)", () => {
    expect(
      wellKnownUrls(
        "https://mcp.example.com/v1/mcp",
        "oauth-protected-resource",
      ),
    ).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp",
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    ]);
  });

  it("follows a protected resource to its authorization server", async () => {
    const { fetchJson } = documents({
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": {
        resource: "https://mcp.example.com/mcp",
        authorization_servers: ["https://auth.example.com"],
      },
      "https://auth.example.com/.well-known/oauth-authorization-server": AS,
    });
    const found = await discoverProtectedResource(
      fetchJson,
      "https://mcp.example.com/mcp",
    );
    expect(found).toMatchObject({
      status: "ok",
      client_registration: "dcr",
      token_endpoint: "https://auth.example.com/token",
      code_challenge_methods: ["S256"],
    });
  });

  it("falls back to metadata at the resource's own origin", async () => {
    const { fetchJson } = documents({
      "https://mcp.example.com/.well-known/oauth-authorization-server": {
        ...AS,
        client_id_metadata_document_supported: true,
      },
    });
    const found = await discoverProtectedResource(
      fetchJson,
      "https://mcp.example.com/mcp",
    );
    expect(found.client_registration).toBe("cimd");
  });

  it("reports a server with no OAuth metadata instead of inventing one", async () => {
    const { fetchJson } = documents({});
    expect(
      await discoverProtectedResource(fetchJson, "https://mcp.example.com/mcp"),
    ).toMatchObject({
      status: "no_metadata",
    });
    expect(
      await discoverAuthorizationServer(fetchJson, "https://auth.example.com"),
    ).toBeNull();
  });

  it("keeps only https endpoints", () => {
    expect(
      summarizeServerMetadata({
        ...AS,
        token_endpoint: "http://auth.example.com/token",
      }).token_endpoint,
    ).toBeNull();
  });
});
