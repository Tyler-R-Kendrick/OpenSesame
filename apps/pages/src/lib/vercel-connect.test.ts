import {
  getConnectorMetadata,
  revokeToken,
  startAuthorization,
} from "@vercel/connect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizeConnection,
  createConnection,
  listConnections,
} from "./connections.js";
import {
  CONNECT_API,
  authorizeVercelConnection,
  createVercelConnection,
  getVercelConnection,
  listVercelConnections,
  revokeVercelConnection,
  setVercelConnectAuth,
  toConnectConnection,
  vercelConnectConfigured,
  vercelConnectSeams,
} from "./vercel-connect.js";

const originalFetch = vercelConnectSeams.fetch;
const originalStart = vercelConnectSeams.startAuthorization;
const originalMeta = vercelConnectSeams.getConnectorMetadata;
const originalRevoke = vercelConnectSeams.revokeToken;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function slackConnector() {
  return {
    id: "scl_slack",
    uid: "slack/acme",
    name: "acme-slack",
    displayName: "Acme Slack",
    service: "slack",
    type: "slack",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    website: "https://slack.com",
    docsite: "https://api.slack.com",
    userTokens: { scopes: ["chat:write"] },
  };
}

function stubConnect(handler: (url: string, init?: RequestInit) => Response) {
  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  );
  vercelConnectSeams.fetch = spy as typeof fetch;
  return spy;
}

afterEach(() => {
  setVercelConnectAuth(null);
  vercelConnectSeams.fetch = originalFetch;
  vercelConnectSeams.startAuthorization = originalStart;
  vercelConnectSeams.getConnectorMetadata = originalMeta;
  vercelConnectSeams.revokeToken = originalRevoke;
});

describe("Vercel Connect SDK", () => {
  it("wires authorize, metadata, and revoke to @vercel/connect", () => {
    expect(vercelConnectSeams.startAuthorization).toBe(startAuthorization);
    expect(vercelConnectSeams.getConnectorMetadata).toBe(getConnectorMetadata);
    expect(vercelConnectSeams.revokeToken).toBe(revokeToken);
  });

  it("lists connectors from api.vercel.com, never the token route", async () => {
    setVercelConnectAuth({
      token: "vercel_token",
      teamId: "team_1",
      projectId: "prj_1",
    });
    const spy = stubConnect((url) => {
      expect(url).not.toContain("/connect/token");
      return jsonResponse({ connectors: [slackConnector()] });
    });

    const rows = await listVercelConnections();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connectionId: "scl_slack",
      providerId: "slack",
      displayName: "Acme Slack",
      connectionRef: "connect://slack/acme",
    });
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url.startsWith(`${CONNECT_API}/v2/connect/connectors?`)).toBe(true);
    expect(url).toContain("teamId=team_1");
    expect(url).toContain("projectId=prj_1");
    const headers = new Headers(spy.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer vercel_token");
  });

  it("creates over REST and authorizes through startAuthorization", async () => {
    setVercelConnectAuth({ token: "vercel_token", teamId: "team_1" });
    const spy = stubConnect((url, init) => {
      expect(url).not.toContain("/connect/token");
      if (url.includes("/v1/connect/connectors") && init?.method === "POST") {
        return jsonResponse(slackConnector());
      }
      return jsonResponse({ error: { code: "not_found" } }, 404);
    });
    const start = vi.fn().mockResolvedValue({
      url: "https://connect.vercel.com/authorize/slack",
      request: "req_1",
      verifier: "ver_1",
      expiresAt: 1_700_000_600_000,
    });
    vercelConnectSeams.startAuthorization = start;

    const created = await createVercelConnection({
      providerId: "slack",
      displayName: "Acme Slack",
    });
    const authorized = await authorizeVercelConnection("slack/acme", [
      "chat:write",
    ]);

    expect(created.connectionId).toBe("scl_slack");
    expect(authorized.authorizationUrl).toBe(
      "https://connect.vercel.com/authorize/slack",
    );
    expect(JSON.parse(String(spy.mock.calls[0]?.[1]?.body))).toEqual({
      service: "slack",
      name: "Acme Slack",
    });
    expect(start).toHaveBeenCalledWith(
      "slack/acme",
      { subject: { type: "app" }, scopes: ["chat:write"] },
      { vercelToken: "vercel_token" },
    );
  });

  it("reads and revokes a connector through the SDK", async () => {
    setVercelConnectAuth({ token: "vercel_token", teamId: "team_1" });
    vercelConnectSeams.getConnectorMetadata = vi.fn().mockResolvedValue({
      id: "scl_slack",
      uid: "slack/acme",
      name: "Acme Slack",
      type: "slack",
      service: "slack",
      clientUrl: "https://slack.com",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_100_000,
      vendor: {},
    });
    vercelConnectSeams.revokeToken = vi.fn().mockResolvedValue(undefined);

    const row = await getVercelConnection("slack/acme");
    const revoked = await revokeVercelConnection("slack/acme");

    expect(row.connectionId).toBe("scl_slack");
    expect(row.providerId).toBe("slack");
    expect(revoked).toEqual({ revoked: true, providerRevocation: "ok" });
    expect(vercelConnectSeams.getConnectorMetadata).toHaveBeenCalledWith(
      "slack/acme",
      { vercelToken: "vercel_token" },
    );
    expect(vercelConnectSeams.revokeToken).toHaveBeenCalledWith(
      "slack/acme",
      { subject: { type: "app" } },
      { vercelToken: "vercel_token" },
    );
  });

  it("maps a Connect connector without leaking a token field", () => {
    const mapped = toConnectConnection(slackConnector(), {
      token: "secret",
      teamId: "team_1",
    });
    expect(mapped).toBeTruthy();
    expect(JSON.stringify(mapped)).not.toMatch(/secret|token/i);
    expect(mapped?.grantedScopes).toEqual(["chat:write"]);
    expect(mapped?.egress.authorities).toEqual(["slack.com"]);
  });
});

describe("Connections live path", () => {
  it("list/create/authorize go to Connect, not Host, when a token is set", async () => {
    setVercelConnectAuth({ token: "vercel_token" });
    const spy = stubConnect((url, init) => {
      expect(String(url)).toContain("api.vercel.com");
      expect(String(url)).not.toContain("/api/v1/");
      expect(String(url)).not.toContain("/connect/token");
      if (init?.method === "POST") return jsonResponse(slackConnector());
      return jsonResponse({ connectors: [slackConnector()] });
    });
    vercelConnectSeams.startAuthorization = vi.fn().mockResolvedValue({
      url: "https://connect.vercel.com/authorize/slack",
      request: "req_1",
      verifier: "ver_1",
      expiresAt: "2026-09-17T00:00:00.000Z",
    });

    expect(vercelConnectConfigured()).toBe(true);
    await listConnections();
    await createConnection({ providerId: "slack" });
    await authorizeConnection("scl_slack");

    const urls = spy.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes("/v2/connect/connectors"))).toBe(
      true,
    );
    expect(urls.some((url) => url.includes("/v1/connect/connectors"))).toBe(
      true,
    );
    expect(vercelConnectSeams.startAuthorization).toHaveBeenCalled();
  });
});
