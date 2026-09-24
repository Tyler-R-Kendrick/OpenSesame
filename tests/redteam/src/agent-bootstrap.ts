import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Owned test authority; real MCP acquisition still uses its unmodified UDS client. */
export async function agentBootstrap(wrongAudience = false) {
  const directory = await mkdtemp(join(tmpdir(), "redteam-agent-"));
  const socket = join(directory, "agent.sock");
  const handle = randomBytes(32).toString("hex");
  const client = randomUUID();
  const audience = "urn:opensesame:agent:mcp-host";
  const token = `agent-capability:${randomBytes(32).toString("hex")}`;
  let consumed = false;
  let exchanges = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 4096) request.destroy();
    });
    request.on("end", () => {
      let valid = false;
      try {
        const value = JSON.parse(body);
        valid =
          request.method === "POST" &&
          request.url === "/v1/agent-capabilities/token" &&
          !consumed &&
          value.launch_handle === handle &&
          value.client_id === client &&
          value.audience === audience;
      } catch {
        valid = false;
      }
      response.setHeader("content-type", "application/json");
      if (!valid) {
        response
          .writeHead(401)
          .end(JSON.stringify({ error: "invalid_launch" }));
        return;
      }
      consumed = true;
      exchanges++;
      response.end(
        JSON.stringify({
          access_token: token,
          token_type: "Bearer",
          expires_in: 300,
          client_id: client,
          audience: wrongAudience
            ? "urn:opensesame:agent:mcp-client"
            : audience,
          scope: [
            "host.tasks.read",
            "host.tasks.create",
            "host.tasks.invoke",
            "host.tasks.terminate",
            "host.sync.read",
            "host.sync.write",
          ],
        }),
      );
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, () => resolve());
    });
    await chmod(socket, 0o600);
  } catch (error) {
    server.close();
    await rm(directory, { recursive: true });
    throw error;
  }
  return {
    env: {
      OPENSESAME_AGENT_SOCK: socket,
      OPENSESAME_AGENT_CLIENT_ID: client,
      OPENSESAME_AGENT_LAUNCH_HANDLE: handle,
    },
    headers: {
      authorization: `Bearer ${token}`,
      "x-opensesame-agent-client": client,
      "x-opensesame-agent-audience": audience,
    },
    exchanges: () => exchanges,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true });
    },
  };
}
