/** Owned verified TLS wire fixture; no hosted provider or browser-network substitution. */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import {
  fixture as oauthOracle,
  target,
} from "@opensesame/app-core/lib/native-mcp-oauth-fixtures.test-helper.js";
import { tlsFetch } from "@opensesame/app-core/lib/native-s3-backup.test-support.js";
import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { expect } from "vitest";

export function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "native-mcp-wire-"));
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
    { stdio: "ignore", timeout: 10000 },
  );
  return {
    directory,
    key: readFileSync(join(directory, "key.pem")),
    cert: readFileSync(join(directory, "cert.pem")),
  };
}
type State = {
  requests: Request[];
  hold: string;
  held?: ServerResponse;
  suffix: string;
  premature: boolean;
  entered: ReturnType<typeof deferred>;
  errors: Error[];
  challenge: string | null;
};
async function respond(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  state: State,
  oracle: typeof fetch,
) {
  const parts: Buffer[] = [];
  for await (const part of incoming) parts.push(Buffer.from(part));
  const payload = Buffer.concat(parts);
  const url = String(incoming.headers["x-fixture-url"]);
  if (url === target.metadata.tokenEndpoint) {
    const form = new URLSearchParams(payload.toString());
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_id")).toBe("actual-public-client");
    expect(form.get("resource")).toBe(target.binding.resource);
    const verifier = form.get("code_verifier") ?? "";
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    expect(Buffer.from(digest).toString("base64url")).toBe(state.challenge);
  }
  const headers = new Headers();
  for (let i = 0; i < incoming.rawHeaders.length; i += 2)
    headers.append(
      incoming.rawHeaders[i] ?? "",
      incoming.rawHeaders[i + 1] ?? "",
    );
  headers.delete("x-fixture-url");
  const request = new Request(url, {
    method: incoming.method,
    headers,
    body: parts.length ? payload : undefined,
    credentials: "omit",
    redirect: "manual",
  });
  state.requests.push(request.clone());
  const response =
    url === target.binding.endpoint
      ? await rpcResponse(request)
      : await oracle(request);
  const text = await response.text();
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (
    state.hold &&
    (url.includes(state.hold) || payload.toString().includes(state.hold))
  ) {
    state.held = outgoing;
    outgoing.once("close", () => {
      state.premature = !outgoing.writableEnded;
    });
    state.suffix = text.slice(1);
    outgoing.write(text.slice(0, 1));
    state.entered.resolve();
  } else outgoing.end(text);
}
async function rpcResponse(request: Request): Promise<Response> {
  expect(request.headers.get("authorization")).toBe("Bearer issued-access");
  if (request.method === "GET") return new Response(null, { status: 405 });
  const rpc: BoundaryValue = JSON.parse(await request.clone().text());
  if (!isJsonObject(rpc) || !isString(rpc.method))
    throw new Error("Invalid fixture MCP request");
  if (
    ["notifications/initialized", "notifications/cancelled"].includes(
      rpc.method,
    )
  )
    return new Response(null, { status: 202 });
  if (!["initialize", "tools/list", "tools/call"].includes(rpc.method))
    throw new Error("Unexpected fixture MCP method");
  if (rpc.method !== "initialize")
    expect(request.headers.get("mcp-protocol-version")).toBe("2025-11-25");
  const result =
    rpc.method === "initialize"
      ? {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "Owned MCP socket", version: "1" },
        }
      : rpc.method === "tools/list"
        ? {
            tools: [
              {
                name: "provider.search",
                inputSchema: {
                  type: "object",
                  properties: { query: { type: "string" } },
                  required: ["query"],
                },
              },
            ],
          }
        : { content: [{ type: "text", text: "Actual owned MCP result" }] };
  return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
}
export async function ownedProtocol() {
  const oracle = oauthOracle();
  const tls = certificate();
  const state: State = {
    requests: [],
    hold: "",
    suffix: "",
    premature: false,
    entered: deferred(),
    errors: [],
    challenge: null,
  };
  const sockets = new Set<Duplex>();
  const server = createServer(tls, (incoming, outgoing) => {
    void respond(incoming, outgoing, state, oracle.ports.fetch).catch(
      (error: Error) => {
        state.errors.push(error);
        outgoing.destroy();
      },
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // Listening on the explicit IPv4 host above yields AddressInfo, never a pipe.
  const address: AddressInfo = overlapCast(server.address());
  expect(address).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
  expect(address.port).toBeGreaterThan(0);
  const { port } = address;
  const actualTls = tlsFetch(tls.cert);
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    expect(request.credentials).toBe("omit");
    expect(request.redirect).toBe("manual");
    const headers = new Headers(request.headers);
    headers.set("x-fixture-url", request.url);
    return actualTls(`https://127.0.0.1:${port}`, {
      method: request.method,
      headers,
      body: request.body ? await request.arrayBuffer() : undefined,
      signal: request.signal,
      redirect: "manual",
      credentials: "omit",
    });
  };
  return {
    fetcher,
    requests: state.requests,
    entered: state.entered,
    consent: (url: string) => {
      state.challenge = new URL(url).searchParams.get("code_challenge");
    },
    hold: (value: string) => {
      state.hold = value;
    },
    finish: () => state.held?.end(state.suffix),
    premature: () => state.premature,
    close: async () => {
      const closed = [...sockets].map((socket) => once(socket, "close"));
      const stopped = once(server, "close");
      server.close();
      server.closeAllConnections();
      await Promise.all([stopped, ...closed]);
      expect(sockets.size).toBe(0);
      expect(state.errors).toEqual([]);
      rmSync(tls.directory, { recursive: true });
    },
  };
}
