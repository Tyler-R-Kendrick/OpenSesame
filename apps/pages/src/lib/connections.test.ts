import { afterEach, describe, expect, it, vi } from "vitest";
import { listConnections, listProviders } from "./connections.js";
import {
  clearHostSession,
  clearSession,
  connectProvisional,
} from "./identity.js";
import { saveSettings } from "./settings.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  clearSession();
  clearHostSession();
  vi.unstubAllGlobals();
});

describe("connection client", () => {
  it("mints one user-scoped Host session and never sends an operator token", async () => {
    saveSettings({
      hostApi: "http://127.0.0.1:8787",
      identityApi: "http://127.0.0.1:8788",
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/v1/principals/provisional")) {
          return response({
            principalId: "principal:pages",
            accessToken: "identity-pages",
            expiresAt: "2099-01-01T00:00:00Z",
          });
        }
        if (url.endsWith("/api/v1/device/authorize")) {
          return response({
            device_code: "device-pages",
            user_code: "ABCD-EFGH",
          });
        }
        if (url.endsWith("/v1/device/approve")) return response({ ok: true });
        if (url.endsWith("/api/v1/device/token")) {
          return response({
            access_token: "opaque-session:pages",
            expires_in: 300,
          });
        }
        if (url.endsWith("/api/v1/providers")) {
          return response({
            providers: [
              {
                id: "openbao",
                display_name: "OpenBao",
                categories: ["cloud_secret_manager"],
                capabilities: ["read", "test"],
                authentication: ["workload_identity"],
                execution_targets: ["workload_worker"],
                support: "experimental",
                adapter: "http:openbao",
              },
            ],
          });
        }
        if (url.endsWith("/api/v1/connections")) {
          return response({ connections: [] });
        }
        throw new Error(`unexpected request ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await connectProvisional();
    const providers = await listProviders();
    await listConnections();

    expect(providers[0]?.displayName).toBe("OpenBao");
    const hostRequests = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/api/v1/connections"),
    );
    expect(
      new Headers(hostRequests[0]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer opaque-session:pages");
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/v1/device/authorize"),
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("operator:");
  });
});
