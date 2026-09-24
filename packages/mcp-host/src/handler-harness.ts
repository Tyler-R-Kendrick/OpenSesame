/**
 * Test-only harness shared by the per-tool handler suites. The SDK's
 * registered handlers are not reachable outside a live client/server
 * exchange, so — like tools-handlers.test.ts — this registers the host tools
 * on a minimal fake that records the last-arg callback per tool name, then
 * lets suites invoke the handlers directly against a stubbed fetch.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type BoundaryValue,
  isFunction,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { z } from "zod";
import { registerHostTools } from "./tools.js";

type ToolReturn = BoundaryValue | Promise<BoundaryValue>;
type ToolHandler = (...args: BoundaryValue[]) => ToolReturn;

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string() })),
  isError: z.boolean().optional(),
});

export type ToolResult = z.infer<typeof toolResultSchema>;

export function makeRegistrar(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (...args: BoundaryValue[]) => {
      const name = args[0];
      const handler = args[args.length - 1];
      if (!isString(name) || !isFunction(handler)) {
        throw new Error("invalid_test_tool_registration");
      }
      const typedHandler: ToolHandler = overlapCast(handler);
      handlers.set(name, typedHandler);
    },
  };
  const typedServer: McpServer = overlapCast(server);
  registerHostTools(typedServer);
  return handlers;
}

export async function callTool(
  handlers: Map<string, ToolHandler>,
  name: string,
  args?: BoundaryValue,
): Promise<ToolResult> {
  const handler = handlers.get(name);
  if (!handler) {
    throw new Error(`tool ${name} is not registered`);
  }
  return toolResultSchema.parse(await handler(args));
}

export function jsonResponse(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
