/** Actual sealed connector/runtime/MCP SDK plus independently owned HTTPS response. */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { tlsFetch } from "@opensesame/app-core/lib/native-s3-backup.test-support.js";
import { expect } from "vitest";
import { z } from "zod";
import {
  advertisedArguments,
  nativeMcpToolsFixture,
} from "./native-mcp-tools.test-support.js";
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "mcp-discover-owner-"));
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
const Rpc = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
});
type State = {
  hold: boolean;
  status: number;
  held?: ServerResponse;
  pendingBody: string;
  entered: ReturnType<typeof deferred>;
  closed: ReturnType<typeof deferred>;
  physicallyClosed: boolean;
  methods: string[];
  errors: Error[];
};
async function respond(
  request: IncomingMessage,
  response: ServerResponse,
  state: State,
) {
  expect(request.headers.authorization).toBe("Bearer issued-access");
  if (request.method === "GET") {
    response.writeHead(405).end();
    return;
  }
  expect(request.method).toBe("POST");
  const chunks: Buffer[] = [];
  let count = 0;
  for await (const bytes of request) {
    count += bytes.length;
    expect(count).toBeLessThanOrEqual(65536);
    chunks.push(Buffer.from(bytes));
  }
  const rpc = Rpc.parse(JSON.parse(Buffer.concat(chunks).toString()));
  state.methods.push(rpc.method);
  if (rpc.method.startsWith("notifications/")) {
    response.writeHead(202).end();
    return;
  }
  const result =
    rpc.method === "initialize"
      ? {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "Owned discovery server", version: "1.0" },
        }
      : {
          tools: [
            {
              name: "provider.search",
              description: "Search owned discovery records",
              inputSchema: advertisedArguments,
            },
          ],
        };
  expect(["initialize", "tools/list"]).toContain(rpc.method);
  if (rpc.method === "tools/list" && state.status !== 200) {
    response.writeHead(state.status).end();
    return;
  }
  const body = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result });
  response.writeHead(200, { "content-type": "application/json" });
  if (rpc.method === "tools/list" && state.hold) {
    state.held = response;
    state.pendingBody = body.slice(1);
    response.write(body.slice(0, 1));
    request.socket.once("close", () => {
      state.physicallyClosed = true;
      state.closed.resolve();
    });
    state.entered.resolve();
  } else response.end(body);
}
export async function discoveryFixture() {
  const actual = await nativeMcpToolsFixture();
  const tls = certificate();
  const sockets = new Set<Duplex>();
  const state: State = {
    hold: true,
    status: 200,
    pendingBody: "",
    entered: deferred(),
    closed: deferred(),
    physicallyClosed: false,
    methods: [],
    errors: [],
  };
  const server = createServer(tls, (request, response) => {
    void respond(request, response, state).catch((error: Error) => {
      state.errors.push(error);
      response.destroy();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  const fetch = tlsFetch(tls.cert);
  actual.fixture.route.respond = async (request) =>
    fetch(`https://127.0.0.1:${port}/mcp`, {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
      body: request.body ? await request.arrayBuffer() : undefined,
    });
  return {
    actual,
    state,
    release: () => {
      state.hold = false;
      if (!state.held?.destroyed) state.held?.end(state.pendingBody);
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(tls.directory, { recursive: true, force: true });
    },
  };
}
export async function within<T>(
  work: Promise<T>,
  milliseconds = 2000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Original discovery TLS socket did not close within two seconds.",
              ),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
