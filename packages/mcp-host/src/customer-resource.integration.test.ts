import { chmod, mkdtemp, rm } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isJsonObject, isNumber, overlapCast } from "@opensesame/os-domain";
import { expect, it, vi } from "vitest";
import { resetFetchForTests } from "./host-api.js";
import { registerHostTools } from "./tools.js";
import { connectStreamableHttp } from "./transports/streamable-http.js";

const CLIENT = "d5b21029-5a16-493e-95c2-d7b8821d68b4";
const CAPABILITY = `agent-capability:${"a".repeat(64)}`;
const HTTP_TOKEN = "local-mcp-test-token-0123456789abcdef";
const LAUNCH_HANDLE = "b".repeat(64);
const ciphertext = Buffer.alloc(48, 7).toString("base64");

function base(server: Server): string {
  const address = overlapCast(server.address());
  if (!isJsonObject(address) || !isNumber(address.port))
    throw new Error("expected a TCP listener");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function hostFixture() {
  const received: string[] = [];
  const server = createServer((request, response) => {
    received.push(request.headers.authorization ?? "");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        format: "opensesame-sync-page",
        version: 2,
        blobs: [
          {
            id: "blob-a",
            epoch: 2,
            ciphertext_epoch: 2,
            ciphertext_b64: ciphertext,
          },
        ],
        next_after: null,
        has_more: false,
        foreign_customer_plaintext: "customer-b-private-value",
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: base(server), received };
}

async function grantFixture(socket: string) {
  const server = createServer((request, response) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      text += chunk;
    });
    request.on("end", () => {
      const body = overlapCast(JSON.parse(text));
      if (
        body.launch_handle !== LAUNCH_HANDLE ||
        body.client_id !== CLIENT ||
        body.audience !== "urn:opensesame:agent:mcp-host"
      ) {
        response.writeHead(401);
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          access_token: CAPABILITY,
          token_type: "Bearer",
          expires_in: 120,
          client_id: CLIENT,
          audience: "urn:opensesame:agent:mcp-host",
          scope: ["sync.pull"],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  await chmod(socket, 0o600);
  return server;
}

it("keeps an approved MCP capability pinned to its Host and returns ciphertext only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "os-mcp-customer-"));
  const socket = join(directory, "agent.sock");
  const grant = await grantFixture(socket);
  const customerA = await hostFixture();
  const customerB = await hostFixture();
  resetFetchForTests();
  vi.stubEnv("OPENSESAME_AGENT_LAUNCH_HANDLE", LAUNCH_HANDLE);
  vi.stubEnv("OPENSESAME_AGENT_CLIENT_ID", CLIENT);
  vi.stubEnv("OPENSESAME_AGENT_SOCK", socket);
  vi.stubEnv("OPENSESAME_HOST_API", customerA.base);
  const server = new McpServer({
    name: "customer-isolation-test",
    version: "0.0.0",
  });
  registerHostTools(server);
  const running = await connectStreamableHttp(server, {
    host: "127.0.0.1",
    port: 0,
    token: HTTP_TOKEN,
  });
  const client = new Client({
    name: "customer-isolation-client",
    version: "0.0.0",
  });
  try {
    const httpTransport = new StreamableHTTPClientTransport(
      new URL(`${base(running.server)}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${HTTP_TOKEN}` } } },
    );
    // SAFETY: this SDK class implements Transport; its optional sessionId
    // declaration explicitly permits undefined with exactOptionalPropertyTypes.
    await client.connect(
      overlapCast<StreamableHTTPClientTransport, Transport>(httpTransport),
    );
    const own = await client.callTool({ name: "sync_pull", arguments: {} });
    expect(own.isError).toBe(false);
    expect(JSON.stringify(own)).toContain(ciphertext);
    expect(JSON.stringify(own)).not.toContain("customer-b-private-value");
    expect(JSON.stringify(own)).not.toContain(CAPABILITY);
    expect(customerA.received).toEqual([`Bearer ${CAPABILITY}`]);
    vi.stubEnv("OPENSESAME_HOST_API", customerB.base);
    const foreign = await client.callTool({ name: "sync_pull", arguments: {} });
    expect(foreign.isError).toBe(true);
    expect(JSON.stringify(foreign)).toContain("sync_pull_failed");
    expect(customerB.received).toEqual([]);
    expect(JSON.stringify(foreign)).not.toContain(CAPABILITY);
  } finally {
    await client.close();
    await running.close();
    await Promise.all([
      close(grant),
      close(customerA.server),
      close(customerB.server),
    ]);
    vi.unstubAllEnvs();
    resetFetchForTests();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
