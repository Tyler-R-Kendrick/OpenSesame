import type { WebMcpToolDescriptor, WebMcpToolResult } from "./detect.js";
import {
  AgentPayloadRefused,
  fenceForAgent,
  looksLikeCredential,
  scrubLocalSecrets,
} from "./fence.js";
import type { WebMcpToolSpec } from "./registrar.js";

function textResult(text: string, isError = false): WebMcpToolResult {
  const result: WebMcpToolResult = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return result;
}

/** One scrubbed line, or a fixed word when the line itself looks like a secret. */
export function safeLine(message: string, fallback: string): string {
  const line = scrubLocalSecrets(message).split("\n")[0]?.trim() ?? "";
  return line.length === 0 || looksLikeCredential(line) ? fallback : line;
}

/**
 * Errors cross to the agent as scrubbed one-line messages — never stacks,
 * never class names, and never anything the fence flags as credential-shaped.
 */
function errorResult(message: string): WebMcpToolResult {
  return textResult(safeLine(message, "tool_failed"), true);
}

export function wrapTool(
  tool: WebMcpToolSpec,
  signal: AbortSignal,
): WebMcpToolDescriptor {
  const assertCurrent = () => {
    if (signal.aborted) throw new Error("registration_retired");
  };
  const descriptor: WebMcpToolDescriptor = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: async (args) => {
      if (signal.aborted) return textResult("registration_retired", true);
      try {
        const value = await tool.execute(args ?? {}, assertCurrent);
        if (signal.aborted) return textResult("registration_retired", true);
        return textResult(fenceForAgent(value));
      } catch (error) {
        if (signal.aborted) return textResult("registration_retired", true);
        if (error instanceof AgentPayloadRefused) {
          return textResult(error.message, true);
        }
        return errorResult(error instanceof Error ? error.message : "");
      }
    },
  };
  if (tool.readOnly === true) descriptor.annotations = { readOnlyHint: true };
  return descriptor;
}
