import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  type RunningHttpTransport,
  connectStreamableHttp,
  resolveHttpConfig,
} from "./transports/streamable-http.js";

const TOKEN = "test-http-token-0123456789abcdef";

function makeServer(): McpServer {
  const server = new McpServer({ name: "test-http", version: "0.0.0" });
  server.tool("ping_tool", "test tool", {}, async () => ({
    content: [{ type: "text", text: JSON.stringify({ pong: true }) }],
  }));
  return server;
}

async function startOnFreePort(): Promise<{
  running: RunningHttpTransport;
  base: string;
}> {
  const running = await connectStreamableHttp(makeServer(), {
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
  });
  const address = running.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected an ephemeral tcp address");
  }
  return { running, base: `http://127.0.0.1:${address.port}` };
}

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    },
  });
}

describe("resolveHttpConfig", () => {
  it("defaults to loopback and requires a strong token", () => {
    const config = resolveHttpConfig({
      OPENSESAME_MCP_HTTP_TOKEN: TOKEN,
    } as NodeJS.ProcessEnv);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(18791);
  });

  it("refuses non-loopback binds fail-closed", () => {
    expect(() =>
      resolveHttpConfig({
        OPENSESAME_MCP_HTTP_LISTEN: "0.0.0.0:18791",
        OPENSESAME_MCP_HTTP_TOKEN: TOKEN,
      } as NodeJS.ProcessEnv),
    ).toThrow("mcp_http_loopback_required");
  });

  it("refuses a missing or short token", () => {
    expect(() => resolveHttpConfig({} as NodeJS.ProcessEnv)).toThrow(
      "mcp_http_token_required",
    );
    expect(() =>
      resolveHttpConfig({
        OPENSESAME_MCP_HTTP_TOKEN: "short",
      } as NodeJS.ProcessEnv),
    ).toThrow("mcp_http_token_required");
  });

  it("refuses malformed listen strings", () => {
    for (const listen of ["nope", ":0", "127.0.0.1:notaport"]) {
      expect(() =>
        resolveHttpConfig({
          OPENSESAME_MCP_HTTP_LISTEN: listen,
          OPENSESAME_MCP_HTTP_TOKEN: TOKEN,
        } as NodeJS.ProcessEnv),
      ).toThrow(/mcp_http_(listen_invalid|loopback_required)/);
    }
  });
});

describe("streamable http transport", () => {
  let running: RunningHttpTransport | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it("rejects requests without a bearer token and names the PRM", async () => {
    const started = await startOnFreePort();
    running = started.running;
    const res = await fetch(`${started.base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: initializeBody(),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      "/.well-known/oauth-protected-resource",
    );
    const body = await res.json();
    expect(body.profile).toBe("mcp-authorization-2026-07-28-bearer");
  });

  it("rejects a wrong token and a non-bearer scheme", async () => {
    const started = await startOnFreePort();
    running = started.running;
    for (const header of [
      `Bearer ${TOKEN}wrong`,
      `Basic ${Buffer.from(`x:${TOKEN}`).toString("base64")}`,
    ]) {
      const res = await fetch(`${started.base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: header,
        },
        body: initializeBody(),
      });
      expect(res.status).toBe(401);
    }
  });

  it("initializes a session with a valid bearer", async () => {
    const started = await startOnFreePort();
    running = started.running;
    const res = await fetch(`${started.base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKEN}`,
      },
      body: initializeBody(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
    const text = await res.text();
    expect(text).toContain('"serverInfo"');
    expect(text).not.toContain(TOKEN);
  });

  it("serves an unauthenticated loopback health probe and 404s elsewhere", async () => {
    const started = await startOnFreePort();
    running = started.running;
    const health = await fetch(`${started.base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      status: "ok",
      transport: "streamable-http",
    });
    const missing = await fetch(`${started.base}/nope`);
    expect(missing.status).toBe(404);
  });

  it("never reads tool credentials: inbound bearer is transport-only", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "transports",
        "streamable-http.ts",
      ),
      "utf8",
    );
    expect(src).not.toContain("OPENSESAME_ACCESS_TOKEN");
    expect(src).not.toContain("OPENSESAME_OPERATOR_TOKEN");
    expect(src).toContain("timingSafeEqual");
    expect(src).toContain("enableDnsRebindingProtection: true");
  });
});
