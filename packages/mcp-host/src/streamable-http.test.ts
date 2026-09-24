import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
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

interface StartedTransport {
  running: RunningHttpTransport;
  base: string;
}

const BoundAddress = z.object({ port: z.number().int().min(0).max(65_535) });

async function startOnFreePort(): Promise<StartedTransport> {
  const running = await connectStreamableHttp(makeServer(), {
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
  });
  // Parse the net-layer address into a port before branching: Server.address()
  // is a union of AddressInfo, a pipe path, and null, and only the first is a
  // valid outcome for a TCP listen.
  const bound = BoundAddress.safeParse(running.server.address());
  if (!bound.success) {
    throw new Error("expected an ephemeral tcp address");
  }
  return { running, base: `http://127.0.0.1:${bound.data.port}` };
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
    const env: NodeJS.ProcessEnv = { OPENSESAME_MCP_HTTP_TOKEN: TOKEN };
    const config = resolveHttpConfig(env);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(18791);
  });

  it("refuses non-loopback binds fail-closed", () => {
    const env: NodeJS.ProcessEnv = {
      OPENSESAME_MCP_HTTP_LISTEN: "0.0.0.0:18791",
      OPENSESAME_MCP_HTTP_TOKEN: TOKEN,
    };
    expect(() => resolveHttpConfig(env)).toThrow("mcp_http_loopback_required");
  });

  it("refuses a missing or short token", () => {
    const empty: NodeJS.ProcessEnv = {};
    expect(() => resolveHttpConfig(empty)).toThrow("mcp_http_token_required");
    const shortToken: NodeJS.ProcessEnv = {
      OPENSESAME_MCP_HTTP_TOKEN: "short",
    };
    expect(() => resolveHttpConfig(shortToken)).toThrow(
      "mcp_http_token_required",
    );
  });

  it("refuses malformed listen strings", () => {
    for (const listen of ["nope", ":0", "127.0.0.1:notaport"]) {
      const env: NodeJS.ProcessEnv = {
        OPENSESAME_MCP_HTTP_LISTEN: listen,
        OPENSESAME_MCP_HTTP_TOKEN: TOKEN,
      };
      expect(() => resolveHttpConfig(env)).toThrow(
        /mcp_http_(listen_invalid|loopback_required)/,
      );
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
