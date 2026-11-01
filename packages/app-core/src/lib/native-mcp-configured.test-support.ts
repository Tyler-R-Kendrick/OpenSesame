/** Independent owned TLS MCP oracle. It has no OAuth discovery, registration or token endpoint. */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { bindNativeBrowserPolicyOrigin } from "./native-browser-policy.js";
import type { NativeDriverInput } from "./native-connector-drivers.js";
import { createConfiguredMcpDriver } from "./native-mcp-configured-driver.js";
import { tlsFetch } from "./native-s3-backup.test-support.js";
import { runtimeFixture } from "./secret-backends/runtime.test-support.js";
import {
  type TailscaleBrowserNode,
  TailscaleNativeHTTPConfiguration,
  bindTailscaleBrowserNode,
} from "./tailscale/browser-node-port.js";
import { openBrowserNodeState } from "./tailscale/browser-node-store.js";
import { vaultStore } from "./vault/store.js";
export const MCP_KEY = "configured_mcp_fixture:secret+sealed";
const Rpc = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
const Echo = z
  .object({
    name: z.literal("echo"),
    arguments: z.object({ text: z.string() }).strict(),
  })
  .strict();
export type McpCredentialMode = "bearer" | "header" | "anonymous";
type OracleState = {
  refuse: boolean;
  echo: boolean;
  hold: string;
  badInitialize: boolean;
};
type RequestRow = {
  path: string;
  method: string;
  rpc: string;
  authorized: boolean;
  ended: boolean;
  closed: boolean;
  premature: boolean;
};
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "mcp-credential-oracle-"));
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
function result(rpc: z.infer<typeof Rpc>, state: OracleState) {
  if (rpc.method === "initialize")
    return {
      protocolVersion: "2025-03-26",
      capabilities: state.badInitialize ? {} : { tools: {} },
      serverInfo: { name: "Actual credential MCP", version: "1" },
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
  if (rpc.method === "tools/call") {
    const args = Echo.parse(rpc.params);
    return {
      content: [
        {
          type: "text",
          text: state.echo ? MCP_KEY : `Credential MCP: ${args.arguments.text}`,
        },
      ],
    };
  }
  throw new Error("Unknown MCP method");
}
function authorized(
  request: IncomingMessage,
  mode: McpCredentialMode,
): boolean {
  if (request.headers.cookie || request.headers["proxy-authorization"])
    return false;
  if (mode === "anonymous")
    return !request.headers.authorization && !request.headers["x-test-mcp-key"];
  if (mode === "bearer")
    return (
      request.headers.authorization === `Bearer ${MCP_KEY}` &&
      !request.headers["x-test-mcp-key"]
    );
  return (
    request.headers["x-test-mcp-key"] === MCP_KEY &&
    !request.headers.authorization
  );
}
function trackRequest(
  request: IncomingMessage,
  response: ServerResponse,
  mode: McpCredentialMode,
  rows: RequestRow[],
) {
  const row: RequestRow = {
    path: request.url ?? "",
    method: request.method ?? "",
    rpc: "",
    authorized: authorized(request, mode),
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
  return row;
}
function sessionMatches(
  request: IncomingMessage,
  rpc: z.infer<typeof Rpc>,
): boolean {
  return (
    rpc.method === "initialize" ||
    (request.headers["mcp-session-id"] === "configured-credential-session" &&
      request.headers["mcp-protocol-version"] === "2025-03-26")
  );
}
function handler(
  mode: McpCredentialMode,
  state: OracleState,
  rows: RequestRow[],
  faults: string[],
  endpointPath: "/" | "/mcp",
) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const row = trackRequest(request, response, mode, rows);
    if (request.url !== endpointPath) {
      faults.push("non-mcp-egress");
      response.writeHead(404).end();
      return;
    }
    if (!row.authorized || state.refuse) {
      response.writeHead(401).end('{"error":"unauthorized"}');
      return;
    }
    if (request.method === "GET") {
      response.writeHead(405).end();
      return;
    }
    if (request.method !== "POST") {
      faults.push("unexpected-method");
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    if (body.includes(MCP_KEY)) {
      faults.push("credential-in-body");
      response.writeHead(400).end();
      return;
    }
    try {
      const rpc = Rpc.parse(JSON.parse(body));
      row.rpc = rpc.method;
      if (!sessionMatches(request, rpc)) {
        faults.push("unbound-session");
        response.writeHead(400).end();
        return;
      }
      if (rpc.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      if (state.hold === rpc.method) {
        response.flushHeaders();
        response.write('{"jsonrpc":"2.0",');
        return;
      }
      if (rpc.method === "initialize")
        response.setHeader("mcp-session-id", "configured-credential-session");
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: result(rpc, state),
        }),
      );
    } catch {
      faults.push("invalid-protocol");
      response.writeHead(400).end();
    }
  };
}
export async function configuredMcpFixture(
  mode: McpCredentialMode = "bearer",
  endpointPath: "/" | "/mcp" = "/mcp",
) {
  const local = await runtimeFixture();
  const tls = certificate();
  const state: OracleState = {
    refuse: false,
    echo: false,
    hold: "",
    badInitialize: false,
  };
  const rows: RequestRow[] = [];
  const faults: string[] = [];
  const server = createServer(
    tls,
    handler(mode, state, rows, faults, endpointPath),
  );
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = z
    .object({ port: z.number().positive() })
    .parse(server.address());
  const origin = `https://127.0.0.1:${address.port}`;
  const abort = new AbortController();
  const fetcher = tlsFetch(tls.cert);
  const transport = {
    signal: abort.signal,
    assertCurrent: () => abort.signal.throwIfAborted(),
    supportsNativeOrigin: (candidate: string) => {
      abort.signal.throwIfAborted();
      return candidate === origin;
    },
    fetch: fetcher,
  };
  const owner = {
    transport,
    tomb: vaultStore.getSnapshot().tomb,
    close: () => {},
  };
  const driver = createConfiguredMcpDriver({ capture: async () => owner });
  const input: NativeDriverInput = {
    providerId: "adobe",
    displayName: "Explicit configured MCP",
    method: "mcp",
    parameters: {
      mcp_authentication: mode,
      mcp_url: endpointPath === "/" ? origin : `${origin}/mcp`,
      mcp_resource: `${origin}/`,
      mcp_transport: "streamable-http",
    },
    credentials: mode === "anonymous" ? {} : { mcp_token: MCP_KEY },
    requestedScopes: {},
    targetIds: {},
  };
  if (mode === "header") input.parameters.mcp_header = "X-Test-Mcp-Key";
  const releaseOrigin = bindNativeBrowserPolicyOrigin(
    () => "https://opensesame-labs.github.io",
  );
  return {
    local,
    state,
    rows,
    faults,
    abort,
    owner,
    driver,
    input,
    origin,
    fetcher,
    async close() {
      abort.abort();
      releaseOrigin();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(tls.directory, { recursive: true, force: true });
      await local.close();
    },
  };
}

/** Typed original-node carrier to the real owned TLS oracle, not a GoWorker/WASM proof. */
export async function bindConfiguredMcpNode(
  f: Awaited<ReturnType<typeof configuredMcpFixture>>,
) {
  const config = {
    hostname: "credential-mcp-browser",
    controlURL: "https://controlplane.tailscale.com",
    nativeHTTP: TailscaleNativeHTTPConfiguration.parse({
      version: 1,
      exitNodeID: "approved-fixture-exit",
      trustMode: "public",
      targets: [{ origin: f.origin, prefixes: ["203.0.113.0/24"] }],
    }),
  };
  await openBrowserNodeState(config, vaultStore.getSnapshot().tomb, () => {
    if (vaultStore.getSnapshot().status !== "unlocked")
      throw new Error("Vault locked");
  });
  const lifetime = new AbortController();
  let captures = 0;
  const node: TailscaleBrowserNode = {
    captureNativeHTTP: (owner) => {
      captures++;
      const signal = AbortSignal.any([owner, lifetime.signal]);
      const assertCurrent = () => signal.throwIfAborted();
      return {
        signal,
        assertCurrent,
        fetch: (input, init) => {
          assertCurrent();
          const request = new Request(input, init);
          if (new URL(request.url).origin !== f.origin)
            throw new Error("Foreign MCP route");
          return f.fetcher(request, {
            signal: AbortSignal.any([signal, request.signal]),
          });
        },
      };
    },
    snapshot: () => ({
      status: "connected",
      hostname: config.hostname,
      controlURL: config.controlURL,
      authURL: "",
      addresses: ["100.64.0.3"],
      peerCount: 1,
      failure: "",
    }),
    subscribe: () => () => {},
    start: async () => {},
    stop: () => lifetime.abort(),
    forget: async () => {},
    login() {},
    get: async () => {
      throw new Error("No peer fixture");
    },
  };
  const release = bindTailscaleBrowserNode(node);
  return {
    lifetime,
    captures: () => captures,
    close: () => {
      lifetime.abort();
      release();
    },
  };
}
