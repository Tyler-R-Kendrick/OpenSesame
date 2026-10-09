import { chmod, mkdtemp, rm } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isJsonObject, isNumber, overlapCast } from "@opensesame/os-domain";
import { expect, it } from "vitest";

const CLIENT = "bf562a55-4296-442e-a865-127918d3df56";
const CAPABILITY = `agent-capability:${"c".repeat(64)}`;
const LAUNCH_HANDLE = "d".repeat(64);
const ciphertext = Buffer.alloc(48, 9).toString("base64");

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
  const address = overlapCast(server.address());
  if (!isJsonObject(address) || !isNumber(address.port))
    throw new Error("expected a TCP listener");
  return { server, base: `http://127.0.0.1:${address.port}`, received };
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
        body.audience !== "urn:opensesame:agent:mcp-client"
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
          audience: "urn:opensesame:agent:mcp-client",
          scope: ["sync.pull"],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  await chmod(socket, 0o600);
  return server;
}

it("preserves customer authority through the real MCP stdio executable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "os-mcp-client-customer-"));
  const socket = join(directory, "agent.sock");
  const grant = await grantFixture(socket);
  const customerA = await hostFixture();
  const customerB = await hostFixture();
  const client = new Client({
    name: "customer-isolation-client",
    version: "0.0.0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: {
      NODE_ENV: "test",
      OPENSESAME_HOST_API: customerA.base,
      OPENSESAME_AGENT_LAUNCH_HANDLE: LAUNCH_HANDLE,
      OPENSESAME_AGENT_CLIENT_ID: CLIENT,
      OPENSESAME_AGENT_SOCK: socket,
    },
  });
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    expect(
      catalog.tools.some((tool) => /materialize|get_secret/i.test(tool.name)),
    ).toBe(false);
    const own = await client.callTool({ name: "sync_pull", arguments: {} });
    expect(own.isError).not.toBe(true);
    expect(JSON.stringify(own)).toContain(ciphertext);
    expect(JSON.stringify(own)).not.toContain("customer-b-private-value");
    const override = await client.callTool({
      name: "sync_pull",
      arguments: {
        hostUrl: customerB.base,
        accessToken: "customer-b-access-token",
      },
    });
    expect(override.isError).not.toBe(true);
    expect(JSON.stringify(override)).toContain(ciphertext);
    expect(customerB.received).toEqual([]);
    expect(customerA.received).toEqual([
      `Bearer ${CAPABILITY}`,
      `Bearer ${CAPABILITY}`,
    ]);
    expect(JSON.stringify(own) + JSON.stringify(override)).not.toContain(
      CAPABILITY,
    );
    expect(JSON.stringify(override)).not.toContain("customer-b-access-token");
  } finally {
    await client.close();
    await Promise.all([
      close(grant),
      close(customerA.server),
      close(customerB.server),
    ]);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
