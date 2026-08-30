import { assertsNoSecretNames } from "@opensesame/capability-registry";
import {
  type BoundaryObject,
  type BoundaryValue,
  type JsonObject,
  isFunction,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import type {
  ModelContextApi,
  Unregister,
  WebMcpToolDescriptor,
  WebMcpToolResult,
} from "./detect.js";
import {
  AgentPayloadRefused,
  fenceForAgent,
  looksLikeCredential,
  scrubLocalSecrets,
} from "./fence.js";

export type WebMcpToolSpec = {
  name: string;
  description: string;
  inputSchema: JsonObject;
  execute: (args: JsonObject) => BoundaryValue | Promise<BoundaryValue>;
};

export type WebMcpRegistrar = {
  register: (tools: readonly WebMcpToolSpec[]) => Unregister;
};

const TOOL_PREFIX = "opensesame_";

function textResult(text: string, isError = false): WebMcpToolResult {
  const result: WebMcpToolResult = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return result;
}

/**
 * Errors cross to the agent as scrubbed one-line messages — never stacks,
 * never class names, and never anything the fence flags as credential-shaped.
 */
function errorResult(message: string): WebMcpToolResult {
  const line = scrubLocalSecrets(message).split("\n")[0]?.trim() ?? "";
  const text =
    line.length === 0 || looksLikeCredential(line) ? "tool_failed" : line;
  return textResult(text, true);
}

function toUnregister(handle: BoundaryValue): Unregister | null {
  if (isFunction(handle)) {
    const fn = handle;
    return () => {
      fn();
    };
  }
  if (handle !== null && isTypeofObject(handle) && !Array.isArray(handle)) {
    const handleObject: BoundaryObject = overlapCast(handle);
    const unregisterValue = handleObject.unregister;
    if (isFunction(unregisterValue)) {
      return () => {
        unregisterValue.call(handleObject);
      };
    }
  }
  return null;
}

function wrapTool(tool: WebMcpToolSpec): WebMcpToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: async (args) => {
      try {
        const value = await tool.execute(args ?? {});
        return textResult(fenceForAgent(value));
      } catch (error) {
        if (error instanceof AgentPayloadRefused) {
          return textResult(error.message, true);
        }
        return errorResult(error instanceof Error ? error.message : "");
      }
    },
  };
}

/**
 * Registrar over a detected `ModelContextApi`. Names are validated even when
 * the API is absent, so a page misdeclaring a secret-shaped tool fails fast
 * everywhere — not only in browsers that ship WebMCP.
 */
export function createWebMcpRegistrar(
  api: ModelContextApi | null,
  options: { appId: string },
): WebMcpRegistrar {
  const { appId } = options;
  return {
    register(tools) {
      const names = tools.map((tool) => tool.name);
      for (const name of names) {
        if (!name.startsWith(TOOL_PREFIX)) {
          throw new Error(`webmcp_tool_prefix_required:${appId}:${name}`);
        }
      }
      assertsNoSecretNames(names);
      if (!api) return () => {};

      const descriptors = tools.map(wrapTool);
      const handles: Unregister[] = [];
      if (api.registerTool) {
        for (const descriptor of descriptors) {
          const handle = toUnregister(api.registerTool(descriptor));
          if (handle) handles.push(handle);
        }
      } else if (api.provideContext) {
        api.provideContext({ description: appId, tools: descriptors });
        handles.push(() => {
          api.provideContext?.({ description: appId, tools: [] });
        });
      }

      let done = false;
      return () => {
        if (done) return;
        done = true;
        for (const handle of handles) handle();
      };
    },
  };
}
