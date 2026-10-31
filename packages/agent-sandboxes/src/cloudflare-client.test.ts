import { describe, expect, it, vi } from "vitest";
import { CloudflareBrowserRunClient } from "./cloudflare-client.js";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function jsonResponse(body: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const endpoint =
  "https://api.cloudflare.com/client/v4/accounts/acct-1/browser-run/devtools/browser";
const socket =
  "wss://api.cloudflare.com/client/v4/accounts/acct-1/browser-run/devtools/browser/sess-9";

describe("CloudflareBrowserRunClient", () => {
  it("sends the documented guardrails and keep_alive query, and accepts the direct response", async () => {
    const fetchImpl: typeof fetch = async (url, init) => {
      expect(String(url)).toBe(`${endpoint}?keep_alive=120000`);
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer token-1",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        guardrails: {
          allowedDomains: ["accounts.example.test", "idp.example.test"],
        },
      });
      return jsonResponse({
        sessionId: "sess-9",
        webSocketDebuggerUrl: socket,
      });
    };
    const client = new CloudflareBrowserRunClient({
      accountId: "acct-1",
      apiToken: "token-1",
      keepAliveMs: 120_000,
      fetchImpl,
    });
    await expect(
      client.createSession(["accounts.example.test", "idp.example.test"]),
    ).resolves.toEqual({ sessionId: "sess-9", webSocketUrl: socket });
  });

  it("derives the documented socket path if the optional URL is omitted", async () => {
    const client = new CloudflareBrowserRunClient({
      accountId: "acct-1",
      apiToken: "token-1",
      fetchImpl: async () => jsonResponse({ sessionId: "sess-9" }),
    });
    await expect(
      client.createSession(["accounts.example.test"]),
    ).resolves.toEqual({ sessionId: "sess-9", webSocketUrl: socket });
  });

  it.each([
    "wss://attacker.example/devtools/browser/sess-9",
    "ws://api.cloudflare.com/client/v4/accounts/acct-1/browser-run/devtools/browser/sess-9",
    "wss://api.cloudflare.com:444/client/v4/accounts/acct-1/browser-run/devtools/browser/sess-9",
    "wss://other@api.cloudflare.com/client/v4/accounts/acct-1/browser-run/devtools/browser/sess-9",
    "wss://api.cloudflare.com/client/v4/accounts/acct-1/browser-run/devtools/browser/other",
    `${socket}?credential=leak`,
    `${socket}#fragment`,
  ])(
    "rejects and deletes a session with an untrusted socket %s",
    async (url) => {
      const calls: { url: string; init: RequestInit | undefined }[] = [];
      const client = new CloudflareBrowserRunClient({
        accountId: "acct-1",
        apiToken: "token-1",
        fetchImpl: async (input, init) => {
          calls.push({ url: String(input), init });
          return jsonResponse({
            sessionId: "sess-9",
            webSocketDebuggerUrl: url,
          });
        },
      });
      await expect(
        client.createSession(["accounts.example.test"]),
      ).rejects.toThrow("untrusted CDP endpoint");
      expect(calls).toHaveLength(2);
      expect(calls[1]?.url).toBe(`${endpoint}/sess-9`);
      expect(calls[1]?.init?.method).toBe("DELETE");
      expect(calls[1]?.init?.redirect).toBe("error");
    },
  );

  it.each([
    "https://evil.example",
    "https://api.cloudflare.com.evil.example",
    "http://api.cloudflare.com",
    "http://127.0.0.1:9000",
    "https://user@api.cloudflare.com/client/v4/accounts/acct-1/browser-run",
    "https://api.cloudflare.com/client/v4/accounts/other/browser-run",
  ])("rejects an untrusted API destination %s", (baseUrl) => {
    expect(
      () =>
        new CloudflareBrowserRunClient({
          accountId: "acct-1",
          apiToken: "token-1",
          baseUrl,
        }),
    ).toThrow("untrusted API endpoint");
  });

  it("requires an explicit opt-in for the loopback fake and binds the socket to it", async () => {
    const client = new CloudflareBrowserRunClient({
      accountId: "acct-1",
      apiToken: "token-1",
      baseUrl: "http://127.0.0.1:9123",
      allowInsecureLoopbackForTesting: true,
      fetchImpl: async () =>
        jsonResponse({
          sessionId: "sess-9",
          webSocketDebuggerUrl: "ws://127.0.0.1:9123/devtools/browser/sess-9",
        }),
    });
    await expect(
      client.createSession(["accounts.example.test"]),
    ).resolves.toMatchObject({
      webSocketUrl: "ws://127.0.0.1:9123/devtools/browser/sess-9",
    });
  });

  const sparseDomains: string[] = [];
  sparseDomains.length = 1;
  it.each([
    { allowedDomains: [] },
    { allowedDomains: ["*.example.test"] },
    { allowedDomains: ["https://example.test"] },
    { allowedDomains: ["bad..example"] },
    { allowedDomains: ["K.example.test"] },
    { allowedDomains: Array(51).fill("example.test") },
    { allowedDomains: sparseDomains },
  ])(
    "fails before allocation for invalid guardrail hostnames",
    async ({ allowedDomains }) => {
      const fetchImpl = vi.fn();
      const client = new CloudflareBrowserRunClient({
        accountId: "acct-1",
        apiToken: "token-1",
        fetchImpl,
      });
      await expect(client.createSession(allowedDomains)).rejects.toThrow(
        "invalid guardrail hostnames",
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("rejects invalid identifiers and unsupported timeout settings before I/O", async () => {
    expect(
      () =>
        new CloudflareBrowserRunClient({
          accountId: "acct/other",
          apiToken: "secret",
        }),
    ).toThrow("invalid account id");
    expect(
      () =>
        new CloudflareBrowserRunClient({
          accountId: "acctK",
          apiToken: "secret",
        }),
    ).toThrow("invalid account id");
    expect(
      () =>
        new CloudflareBrowserRunClient({
          accountId: "acct-1",
          apiToken: "secret",
          keepAliveMs: 1,
        }),
    ).toThrow("invalid keep_alive");
    const legacyOptions = {
      accountId: "acct-1",
      apiToken: "secret",
      sessionTimeoutMs: 120_000,
    };
    expect(() => new CloudflareBrowserRunClient(legacyOptions)).toThrow(
      "unsupported",
    );
    const fetchImpl = vi.fn();
    const client = new CloudflareBrowserRunClient({
      accountId: "acct-1",
      apiToken: "token-1",
      fetchImpl,
    });
    await expect(client.closeSession("..")).rejects.toThrow(
      "invalid session id",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not leak server error bodies", async () => {
    const client = new CloudflareBrowserRunClient({
      accountId: "acct-1",
      apiToken: "token-1",
      fetchImpl: async () =>
        jsonResponse({ errors: [{ message: "server secret" }] }, 429),
    });
    await expect(
      client.createSession(["accounts.example.test"]),
    ).rejects.toThrow("HTTP 429");
  });

  it("cleans up valid session IDs when the returned URL has the wrong type", async () => {
    const calls: string[] = [];
    const client = new CloudflareBrowserRunClient({
      accountId: "acct-1",
      apiToken: "token-1",
      fetchImpl: async (url, init) => {
        calls.push(`${init?.method} ${url}`);
        return jsonResponse({ sessionId: "sess-9", webSocketDebuggerUrl: 42 });
      },
    });
    await expect(
      client.createSession(["accounts.example.test"]),
    ).rejects.toThrow("invalid session response");
    expect(calls).toEqual([`POST ${endpoint}`, `DELETE ${endpoint}/sess-9`]);
  });

  it("reports cleanup failures without including a server error body", async () => {
    const client = new CloudflareBrowserRunClient({
      accountId: "acct-1",
      apiToken: "token-1",
      fetchImpl: async (_url, init) =>
        init?.method === "DELETE"
          ? jsonResponse({ secret: "do-not-display" }, 500)
          : jsonResponse({
              sessionId: "sess-9",
              webSocketDebuggerUrl: "wss://evil.test/",
            }),
    });
    await expect(
      client.createSession(["accounts.example.test"]),
    ).rejects.toThrow("untrusted CDP endpoint; session cleanup failed");
    await expect(client.closeSession("sess-9")).rejects.toThrow("HTTP 500");
  });

  it("snapshots the validated token and idle timeout", async () => {
    const fetchImpl: typeof fetch = async (url, init) => {
      expect(String(url)).toBe(`${endpoint}?keep_alive=120000`);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer token-1",
      );
      return jsonResponse({
        sessionId: "sess-9",
        webSocketDebuggerUrl: socket,
      });
    };
    const options = {
      accountId: "acct-1",
      apiToken: "token-1",
      keepAliveMs: 120_000,
      fetchImpl,
    };
    const client = new CloudflareBrowserRunClient(options);
    options.apiToken = "other";
    options.keepAliveMs = 1;
    await client.createSession(["accounts.example.test"]);
  });
});
