/** A fixed synthetic MCP validator, with no connector, network or root capabilities. */
import { z } from "zod";
const requestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string().max(128), z.number().int()]).optional(),
    method: z.enum([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]),
    params: z.unknown().optional(),
  })
  .strict();
const callSchema = z
  .object({
    name: z.literal("canary.status"),
    arguments: z.object({}).strict().optional(),
  })
  .strict();
export type ControlledMcpRequest = z.infer<typeof requestSchema>;
export function parseControlledMcpRequest(
  request: string,
): ControlledMcpRequest {
  if (new TextEncoder().encode(request).length > 4096)
    throw new Error("Canary request exceeds limit.");
  return requestSchema.parse(JSON.parse(request));
}
export function validateControlledMcpRequest(
  request: ControlledMcpRequest,
): ControlledMcpRequest {
  const message = requestSchema.parse(request);
  if (new TextEncoder().encode(JSON.stringify(message)).length > 4096)
    throw new Error("Canary request exceeds limit.");
  if (message.method === "tools/call") callSchema.parse(message.params);
  return message;
}
export function controlledMcpResponse(message: ControlledMcpRequest) {
  if (message.method === "notifications/initialized") return null;
  if (message.method === "initialize")
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "OpenSesame controlled canary", version: "1" },
      },
    };
  if (message.method === "tools/list")
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "canary.status",
            description: "Read synthetic validator status",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      },
    };
  return {
    jsonrpc: "2.0",
    id: message.id,
    result: {
      content: [
        {
          type: "text",
          text: '{"environment":"synthetic","status":"available"}',
        },
      ],
    },
  };
}
