/** Real owned TLS OAuth + Streamable HTTP resource; no mocked provider responses. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@opensesame/os-domain";
import { z } from "zod";
import type { NativeDriverInput } from "./native-connector-drivers.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import type { NativeOAuthClientOwner } from "./native-oauth-client-config.js";
import { runtimeFixture } from "./secret-backends/runtime.test-support.js";
import { tlsFetch } from "./test/native-s3-backup-fixtures.js";
import { vaultStore } from "./vault/store.js";
export const MCP_CLIENT = "operator: café+client";
export const MCP_SECRET = "vault:密碼 + private client secret";
export const MCP_TOKEN = "owned-mcp-access-0123456789";
export const MCP_REFRESH = "owned-mcp-refresh-0123456789";
const SESSION = "owned-mcp-session-0123456789";
const VERSION = "2025-03-26";
export type McpClientMethod =
  | "none"
  | "client_secret_basic"
  | "client_secret_post";
type State = {
  challenge: string;
  scope: string;
  resource: string;
  redirect: string;
  format: "json" | "sse";
  hold: string;
  refuse: boolean;
  badInitialize: boolean;
  echo: boolean;
  issued: number;
};
type Row = {
  path: string;
  method: string;
  rpc: string;
  authenticated: boolean;
  ended: boolean;
  closed: boolean;
  premature: boolean;
};
function tlsCertificate() {
  const directory = mkdtempSync(join(tmpdir(), "native-oauth-mcp-"));
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
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
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
function validClient(
  request: IncomingMessage,
  form: URLSearchParams,
  method: McpClientMethod,
) {
  if (method === "none")
    return (
      form.get("client_id") === MCP_CLIENT &&
      !form.has("client_secret") &&
      !request.headers.authorization
    );
  if (method === "client_secret_post")
    return (
      form.get("client_id") === MCP_CLIENT &&
      form.get("client_secret") === MCP_SECRET &&
      !request.headers.authorization
    );
  const encode = (value: string) =>
    new URLSearchParams({ v: value }).toString().slice(2);
  return (
    request.headers.authorization ===
      `Basic ${Buffer.from(`${encode(MCP_CLIENT)}:${encode(MCP_SECRET)}`).toString("base64")}` &&
    !form.has("client_id") &&
    !form.has("client_secret")
  );
}
function token(
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
  state: State,
  method: McpClientMethod,
  row: Row,
) {
  const form = new URLSearchParams(body);
  row.authenticated =
    validClient(request, form, method) &&
    form.get("grant_type") === "authorization_code" &&
    form.get("code") === "one-use-code" &&
    form.get("resource") === state.resource &&
    form.get("redirect_uri") === state.redirect &&
    createHash("sha256")
      .update(form.get("code_verifier") ?? "")
      .digest("base64url") === state.challenge;
  if (!row.authenticated) {
    response.writeHead(400).end(
      JSON.stringify({
        error: "invalid_client",
        error_description: MCP_SECRET,
      }),
    );
    return;
  }
  state.issued++;
  response.end(
    JSON.stringify({
      access_token: MCP_TOKEN,
      refresh_token: MCP_REFRESH,
      token_type: "Bearer",
      expires_in: 3600,
      scope: state.scope,
    }),
  );
}
const Rpc = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
function reply(
  response: ServerResponse,
  rpc: z.infer<typeof Rpc>,
  state: State,
  result: JsonObject,
) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result });
  if (state.format === "sse") {
    response.setHeader("content-type", "text/event-stream");
    response.end(`event: message\ndata: ${body}\n\n`);
  } else response.end(body);
}
function toolReply(
  response: ServerResponse,
  rpc: z.infer<typeof Rpc>,
  state: State,
) {
  const args = z
    .object({
      name: z.literal("echo"),
      arguments: z.object({ text: z.string() }).strict(),
    })
    .parse(rpc.params);
  const text = state.echo ? MCP_SECRET : `Actual MCP: ${args.arguments.text}`;
  reply(response, rpc, state, {
    content: [{ type: "text", text }],
    structuredContent: { echo: text },
  });
}
function mcp(
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
  state: State,
  row: Row,
  faults: string[],
) {
  row.authenticated = request.headers.authorization === `Bearer ${MCP_TOKEN}`;
  if (!row.authenticated || state.refuse) {
    response.writeHead(401).end("{}");
    return;
  }
  if (body.includes(MCP_SECRET)) {
    faults.push("client-secret-at-resource");
    response.writeHead(400).end("{}");
    return;
  }
  if (request.method === "GET") {
    response.writeHead(405).end();
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return;
  }
  const rpc = Rpc.parse(JSON.parse(body));
  row.rpc = rpc.method;
  if (
    rpc.method !== "initialize" &&
    (request.headers["mcp-session-id"] !== SESSION ||
      request.headers["mcp-protocol-version"] !== VERSION)
  ) {
    faults.push("session-or-version");
    response.writeHead(400).end("{}");
    return;
  }
  if (state.hold === rpc.method) {
    response.flushHeaders();
    response.write('{"jsonrpc":"2.0",');
    return;
  }
  if (rpc.method === "initialize") {
    response.setHeader("mcp-session-id", SESSION);
    reply(response, rpc, state, {
      protocolVersion: VERSION,
      capabilities: state.badInitialize ? {} : { tools: {} },
      serverInfo: { name: "Owned configured MCP", version: "1.0.0" },
    });
    return;
  }
  if (rpc.method === "notifications/initialized") {
    response.writeHead(202).end();
    return;
  }
  if (rpc.method === "tools/list") {
    reply(response, rpc, state, {
      tools: [
        {
          name: "echo",
          description: "Echo an explicitly supplied safe value.",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: { echo: { type: "string" } },
            required: ["echo"],
            additionalProperties: false,
          },
        },
      ],
    });
    return;
  }
  if (rpc.method === "tools/call") {
    toolReply(response, rpc, state);
    return;
  }
  faults.push("unknown-method");
  response.writeHead(400).end("{}");
}
function mcpHandler(
  state: State,
  rows: Row[],
  faults: string[],
  method: McpClientMethod,
) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const row: Row = {
      path: request.url ?? "",
      method: request.method ?? "",
      rpc: "",
      authenticated: false,
      ended: false,
      closed: false,
      premature: false,
    };
    rows.push(row);
    response.on("finish", () => {
      row.ended = true;
    });
    response.on("close", () => {
      row.closed = true;
      row.premature = !row.ended;
    });
    response.setHeader("content-type", "application/json");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 65536) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString();
    try {
      if (request.url === "/token")
        token(request, response, body, state, method, row);
      else if (request.url === "/mcp")
        mcp(request, response, body, state, row, faults);
      else {
        faults.push("foreign-path");
        response.writeHead(404).end("{}");
      }
    } catch {
      faults.push("invalid-request");
      response.writeHead(400).end("{}");
    }
  };
}
export async function oauthMcpFixture(
  method: McpClientMethod = "none",
  format: "json" | "sse" = "json",
  approvedScope: "read:tools" | "openid profile" = "read:tools",
) {
  const local = await runtimeFixture();
  const tls = tlsCertificate();
  const rows: Row[] = [];
  const faults: string[] = [];
  const state: State = {
    challenge: "",
    scope: approvedScope,
    resource: "",
    redirect: "https://operator.example/auth/native-connector.html",
    format,
    hold: "",
    refuse: false,
    badInitialize: false,
    echo: false,
    issued: 0,
  };
  const server = createServer(tls, mcpHandler(state, rows, faults, method));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = z
    .object({ port: z.number().positive() })
    .parse(server.address());
  const origin = `https://127.0.0.1:${address.port}`;
  state.resource = `${origin}/mcp`;
  const abort = new AbortController();
  const fetcher = tlsFetch(tls.cert);
  const transport: NativeProviderTransport = {
    fetch: fetcher,
    settleCredentialMutation: fetcher,
    signal: abort.signal,
    assertCurrent: () => abort.signal.throwIfAborted(),
  };
  const owner: NativeOAuthClientOwner = {
    transport,
    tomb: vaultStore.getSnapshot().tomb,
    redirectUri: state.redirect,
  };
  const input: NativeDriverInput = {
    providerId: "byo-oauth",
    displayName: "Configured OAuth MCP",
    method: "oauth",
    parameters: {
      client_id: MCP_CLIENT,
      issuer: `${origin}/issuer`,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      resource: state.resource,
      token_auth_method: method,
    },
    credentials: method === "none" ? {} : { client_secret: MCP_SECRET },
    requestedScopes: { user: ["read:tools"] },
    targetIds: {},
  };
  return {
    local,
    state,
    rows,
    faults,
    abort,
    owner,
    input,
    async close() {
      abort.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(tls.directory, { recursive: true, force: true });
      await local.close();
    },
  };
}
