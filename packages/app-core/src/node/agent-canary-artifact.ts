/** Stateless MCP artifacts report detection; no real connector is reachable here. */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type BoundaryValue,
  isJsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import type { createControlledCanaryReceiver } from "./agent-canary-receiver.js";
function resultFor(method: BoundaryValue | undefined) {
  if (method === "initialize")
    return {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "opensesame-canary", version: "1" },
    };
  if (method === "tools/list")
    return {
      tools: [
        {
          name: "canary_status",
          description: "Read detection-only canary status.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    };
  return {
    content: [
      {
        type: "text",
        text: "Detection-only canary. No production authority is available.",
      },
    ],
  };
}
type ArtifactHttp = {
  read: (request: IncomingMessage) => Promise<BoundaryValue>;
  send: <Value>(response: ServerResponse, status: number, value: Value) => void;
};
export async function handleCanaryArtifact(
  receiver: Pick<
    Awaited<ReturnType<typeof createControlledCanaryReceiver>>,
    "observe"
  >,
  request: IncomingMessage,
  response: ServerResponse,
  io: ArtifactHttp,
) {
  const id = (request.url ?? "").slice("/v1/agent-canaries/artifacts/".length);
  if (request.method !== "POST" || !/^[0-9a-f]{64}$/u.test(id))
    throw new Error("Invalid artifact request.");
  const token = request.headers.authorization?.replace(/^Bearer /u, "") ?? "";
  if (!/^[0-9a-f]{64}$/u.test(token))
    throw new Error("Invalid artifact token.");
  const rpc: BoundaryValue = overlapCast(await io.read(request));
  if (!isJsonObject(rpc) || rpc.jsonrpc !== "2.0")
    throw new Error("Invalid artifact protocol.");
  await receiver.observe(id, token, rpc.method === "tools/call");
  if (rpc.id === undefined) {
    response.writeHead(202);
    response.end();
    return;
  }
  io.send(response, 200, {
    jsonrpc: "2.0",
    id: rpc.id,
    result: resultFor(rpc.method),
  });
}
