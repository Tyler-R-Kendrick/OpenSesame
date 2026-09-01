import { assertsNoSecretNames } from "@opensesame/capability-registry";
import {
  type BoundaryObject,
  type BoundaryValue,
  type JsonObject,
  isFunction,
  isJsonObject,
  isString,
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

/**
 * How much of a tool an in-page agent may have. `discoverable` is metadata
 * plus invocation by the browser's own agent; `tutorial_safe` additionally
 * says a scripted in-page tutorial may name it while narrating; and
 * `human_required` says the action belongs to the human at the keyboard, so
 * no agent surface may present it as something it will perform. The value is
 * a declaration by the page that registers the tool — it is read by the
 * surfaces that build agent prompts, and it grants nothing on its own.
 */
export type WebMcpToolDisposition =
  | "discoverable"
  | "tutorial_safe"
  | "human_required";

export type WebMcpToolSpec = {
  name: string;
  description: string;
  inputSchema: JsonObject;
  disposition?: WebMcpToolDisposition;
  execute: (args: JsonObject) => BoundaryValue | Promise<BoundaryValue>;
};

/**
 * Metadata about a tool the page has registered — deliberately without the
 * `execute` member the browser hands back from `getTools()`. Discovery is not
 * authorization: a caller that can list tools must not thereby gain the
 * ability to run one.
 */
export type WebMcpToolSummary = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
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

/** Resolve a spec's declared disposition, defaulting to `discoverable`. */
export function toolDisposition(tool: WebMcpToolSpec): WebMcpToolDisposition {
  return tool.disposition ?? "discoverable";
}

function summarizeTool(entry: BoundaryValue): WebMcpToolSummary | null {
  if (entry === null || !isTypeofObject(entry) || Array.isArray(entry)) {
    return null;
  }
  const descriptor: BoundaryObject = overlapCast(entry);
  const name = descriptor.name;
  if (!isString(name)) return null;
  const description = descriptor.description;
  const inputSchema = descriptor.inputSchema;
  return {
    name,
    description: isString(description) ? description : "",
    inputSchema: isJsonObject(inputSchema) ? inputSchema : {},
  };
}

/**
 * Tools the browser reports as registered on this document, as metadata only.
 * Browsers on the older draft have no `getTools`, so the answer there is `[]`
 * rather than an error — discovery is an enhancement like the rest of WebMCP.
 *
 * Every field is copied out of the browser's descriptor, so nothing a caller
 * receives holds a reference to a callable tool. This package intentionally
 * exports no counterpart that invokes `executeTool`: an in-page tutorial agent
 * that can read this list still has no way to run anything in it, and that is
 * the property the absence of such an export enforces.
 */
export function listRegisteredTools(
  api: ModelContextApi | null,
): readonly WebMcpToolSummary[] {
  const getTools = api?.getTools;
  if (!getTools) return [];
  const listed = getTools();
  if (!Array.isArray(listed)) return [];
  const summaries: WebMcpToolSummary[] = [];
  for (const entry of listed) {
    const summary = summarizeTool(entry);
    if (summary) summaries.push(summary);
  }
  return summaries;
}
