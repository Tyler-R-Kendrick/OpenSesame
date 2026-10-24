/** Real owned TLS/SDK legacy SSE proof using browser-shaped TS fetch, not GoWorker/WASM. */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { bindNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";
import { configureNativeOAuthClient } from "./native-oauth-client-config.js";
import { MCP_TOKEN, oauthMcpFixture } from "./native-oauth-mcp.test-support.js";
import { createNativeOAuthResourceDriver } from "./native-oauth-resource-driver.js";
import { requireNativeOAuthRecord } from "./native-oauth-session.js";
import { tlsFetch } from "./native-s3-backup.test-support.js";
const closes: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "configured-legacy-sse-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  return {
    directory,
    key: readFileSync(join(directory, "key.pem")),
    cert: readFileSync(join(directory, "cert.pem")),
  };
}
const Rpc = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z
    .object({
      name: z.string().optional(),
      arguments: z.object({ text: z.string() }).optional(),
    })
    .optional(),
});
function reply(rpc: z.infer<typeof Rpc>) {
  if (rpc.method === "initialize")
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "Actual legacy SSE", version: "1" },
    };
  if (rpc.method === "tools/list")
    return {
      tools: [
        {
          name: "echo",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
        },
      ],
    };
  if (rpc.method === "tools/call" && rpc.params?.name === "echo")
    return {
      content: [
        { type: "text", text: `Legacy: ${rpc.params.arguments?.text}` },
      ],
    };
  throw new Error("Unexpected RPC operation");
}
async function setup(announce = "/messages") {
  const f = await oauthMcpFixture("client_secret_post");
  closes.push(f.close);
  const tls = certificate();
  const streams = new Map<string, ServerResponse>();
  const rows: {
    path: string;
    method: string;
    authorized: boolean;
    rpc: string;
  }[] = [];
  let sequence = 0;
  const server = createServer(tls, async (request, response) => {
    const url = new URL(request.url ?? "/", "https://fixture.invalid");
    const row = {
      path: url.pathname,
      method: request.method ?? "",
      authorized: request.headers.authorization === `Bearer ${MCP_TOKEN}`,
      rpc: "",
    };
    rows.push(row);
    if (!row.authorized || request.headers.cookie) {
      response.writeHead(401).end();
      return;
    }
    if (url.pathname === "/sse" && request.method === "GET") {
      const id = String(++sequence);
      streams.set(id, response);
      request.on("close", () => streams.delete(id));
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.write(`event: endpoint\ndata: ${announce}?sessionId=${id}\n\n`);
      return;
    }
    if (url.pathname !== "/messages" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    const stream = streams.get(url.searchParams.get("sessionId") ?? "");
    if (!stream) {
      response.writeHead(400).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rpc = Rpc.parse(JSON.parse(Buffer.concat(chunks).toString()));
    row.rpc = rpc.method;
    response.writeHead(202).end();
    if (rpc.id === undefined) return;
    const result = reply(rpc);
    stream.write(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`,
    );
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = z
    .object({ port: z.number().positive() })
    .parse(server.address());
  const origin = `https://127.0.0.1:${address.port}`;
  closes.push(async () => {
    for (const stream of streams.values()) stream.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tls.directory, { recursive: true, force: true });
  });
  const original = f.owner.transport;
  const resourceFetch = tlsFetch(tls.cert);
  f.owner.transport = {
    ...original,
    fetch: (input, init) => {
      const req = new Request(input, init);
      return new URL(req.url).origin === origin
        ? resourceFetch(req, init)
        : original.fetch(req, init);
    },
  };
  f.state.resource = `${origin}/`;
  Object.assign(f.input.parameters, {
    resource: f.state.resource,
    resource_protocol: "mcp",
    mcp_endpoint: `${origin}/sse`,
    mcp_transport: "sse",
    mcp_post_endpoint: `${origin}/messages`,
  });
  closes.push(
    bindNativeOAuthBrowserPort({
      redirectUri: f.state.redirect,
      navigate: () => {
        throw new Error("No navigation");
      },
      scrubCallback: () => {},
      authorize: async (value) => {
        const url = new URL(value);
        expect(url.searchParams.get("scope")).toBe("read:tools");
        expect(url.searchParams.get("resource")).toBe(f.state.resource);
        f.state.challenge = url.searchParams.get("code_challenge") ?? "";
        return new URLSearchParams({
          native_state: url.searchParams.get("state") ?? "",
          native_code: "one-use-code",
        }).toString();
      },
    }),
  );
  const driver = createNativeOAuthResourceDriver({
    supports: () => true,
    capture: () => ({ ...f.owner, close: () => {} }),
  });
  return { ...f, driver, rows };
}
it("runs configured legacy SSE initialize/list/call with exact audience and separately pinned messages path over actual TLS", async () => {
  const f = await setup();
  const saved = await f.driver.configure(f.input);
  await f.driver.authorize?.(saved.connectionId);
  const record = requireNativeOAuthRecord(saved.connectionId);
  expect(record.runtime.verifiedAt).not.toBeNull();
  expect(record.privateState.grants.user?.resource).toBe(f.state.resource);
  const list = await f.driver.invoke(saved.connectionId, "mcp.tools.list", {});
  expect(list.items.map((item) => item.id)).toEqual(["echo"]);
  const result = await f.driver.invoke(saved.connectionId, "mcp.tool:echo", {
    arguments: JSON.stringify({ text: "explicit safe value" }),
  });
  expect(JSON.stringify(result)).toContain("Legacy: explicit safe value");
  expect(
    f.rows.some((row) => row.method === "GET" && row.path === "/sse"),
  ).toBe(true);
  expect(
    f.rows.some((row) => row.rpc === "tools/call" && row.path === "/messages"),
  ).toBe(true);
  expect(f.rows.every((row) => row.authorized)).toBe(true);
});
it("refuses an unpinned server-announced legacy POST destination and retains the issued grant without verification", async () => {
  const f = await setup("/unapproved");
  const saved = await f.driver.configure(f.input);
  await expect(f.driver.authorize?.(saved.connectionId)).rejects.toThrow();
  const record = requireNativeOAuthRecord(saved.connectionId);
  expect(record.runtime.verifiedAt).toBeNull();
  expect(record.privateState.grants).toEqual({});
  expect(
    record.privateState.recovery.some(
      (intent) => intent.grant?.accessToken === MCP_TOKEN,
    ),
  ).toBe(true);
  expect(f.rows.some((row) => row.method === "POST")).toBe(false);
});
it.each(["missing-pin", "foreign-endpoint"])(
  "refuses %s before saving credentials or issuing any HTTP request",
  async (kind) => {
    const f = await setup();
    if (kind === "missing-pin")
      f.input.parameters = Object.fromEntries(
        Object.entries(f.input.parameters).filter(
          ([key]) => key !== "mcp_post_endpoint",
        ),
      );
    else f.input.parameters.mcp_endpoint = "https://unapproved.example/sse";
    await expect(
      configureNativeOAuthClient(f.input, f.owner),
    ).rejects.toThrow();
    expect(f.rows).toEqual([]);
    expect(f.state.issued).toBe(0);
  },
);
