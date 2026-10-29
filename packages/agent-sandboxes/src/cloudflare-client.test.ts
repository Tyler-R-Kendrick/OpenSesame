import { describe, expect, it, vi } from "vitest";
import { CloudflareBrowserRunClient } from "./cloudflare-client.js";

interface FakeApiBody {
  success: boolean;
  errors?: { message: string }[];
  result?: {
    sessionId: string;
    status?: string;
    webSocketDebuggerUrl?: string;
  };
}

function jsonResponse(body: FakeApiBody, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CloudflareBrowserRunClient", () => {
  it("allocates a session and derives the CDP websocket URL", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/acct-1/browser-run/devtools/browser",
      );
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer token-1");
      return jsonResponse({
        success: true,
        errors: [],
        result: { sessionId: "sess-9", status: "active" },
      });
    });
    // SAFETY: the mock implements exactly the (url, init) call shape the client uses; the cast only widens it to the full fetch signature.
    const client = new CloudflareBrowserRunClient({
      accountId: "acct-1",
      apiToken: "token-1",
      fetchImpl: fetchImpl as typeof fetch,
      sessionTimeoutMs: 120_000,
    });
    const session = await client.createSession();
    expect(session).toEqual({
      sessionId: "sess-9",
      webSocketUrl:
        "wss://api.cloudflare.com/client/v4/accounts/acct-1/browser-run/devtools/browser/sess-9",
    });
    const sentBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(sentBody).toEqual({ sessionTimeout: 120_000 });
  });

  it("prefers a webSocketDebuggerUrl returned by the API", async () => {
    const client = new CloudflareBrowserRunClient({
      accountId: "acct-1",
      apiToken: "token-1",
      fetchImpl: async () =>
        jsonResponse({
          success: true,
          result: {
            sessionId: "sess-2",
            webSocketDebuggerUrl: "wss://example.test/custom",
          },
        }),
    });
    await expect(client.createSession()).resolves.toEqual({
      sessionId: "sess-2",
      webSocketUrl: "wss://example.test/custom",
    });
  });

  it("surfaces API errors and deletes sessions", async () => {
    const calls: string[] = [];
    const client = new CloudflareBrowserRunClient({
      accountId: "acct-1",
      apiToken: "token-1",
      fetchImpl: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return jsonResponse(
          { success: false, errors: [{ message: "quota exceeded" }] },
          429,
        );
      },
    });
    await expect(client.createSession()).rejects.toThrow("quota exceeded");
    await client.closeSession("sess-9");
    expect(calls[1]).toContain("DELETE ");
    expect(calls[1]).toContain("/devtools/browser/sess-9");
  });

  it("requires account configuration from the environment of the caller", () => {
    expect(
      () => new CloudflareBrowserRunClient({ accountId: "", apiToken: "" }),
    ).toThrow("account id and API token");
  });
});
