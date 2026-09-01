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
  /**
   * Declares that the tool mutates nothing. Sent to the browser as the draft's
   * `readOnlyHint` annotation, so its agent can tell a lookup from a ceremony
   * before it calls either. A hint, never a control: the tool's own `execute`
   * is what decides what happens.
   */
  readOnly?: boolean;
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

/**
 * A registration the browser refused. The draft rejects a duplicate name, an
 * empty description or a malformed name with a `DOMException`; an early build
 * throws synchronously. Either way the page finds out here instead of in an
 * unhandled-rejection line nobody reads.
 */
export type WebMcpRegistrationFailure = {
  readonly name: string;
  /** One scrubbed line. Never a stack, never anything credential-shaped. */
  readonly reason: string;
};

export type WebMcpRegistrarOptions = {
  appId: string;
  onFailure?: (failure: WebMcpRegistrationFailure) => void;
};

export type WebMcpRegistrar = {
  register: (tools: readonly WebMcpToolSpec[]) => Unregister;
};

const TOOL_PREFIX = "opensesame_";

/**
 * Every tool this package currently has registered with the browser, by name.
 *
 * There is one `modelContext` per document and the browser refuses a name it
 * already holds, so a second registration of a live name — React StrictMode
 * running an effect twice, a router hook handing out a fresh `navigate` — has
 * to retire the first one. Tracking it here, rather than per registrar, is
 * what makes that true across every registrar a page creates.
 */
const live = new Map<string, Unregister>();

/** The names currently registered through this package, sorted. */
export function liveWebMcpToolNames(): readonly string[] {
  return [...live.keys()].sort();
}

function textResult(text: string, isError = false): WebMcpToolResult {
  const result: WebMcpToolResult = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return result;
}

/** One scrubbed line, or a fixed word when the line itself looks like a secret. */
function safeLine(message: string, fallback: string): string {
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

function messageOf(cause: BoundaryValue): string {
  if (cause instanceof Error) return cause.message;
  return isString(cause) ? cause : "";
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

/** The draft's `registerTool` answers with a promise; the early builds with nothing. */
function isThenable(value: BoundaryValue): boolean {
  if (value === null || !isTypeofObject(value) || Array.isArray(value)) {
    return false;
  }
  const record: BoundaryObject = overlapCast(value);
  return isFunction(record.then);
}

function wrapTool(tool: WebMcpToolSpec): WebMcpToolDescriptor {
  const descriptor: WebMcpToolDescriptor = {
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
  if (tool.readOnly === true) descriptor.annotations = { readOnlyHint: true };
  return descriptor;
}

function retire(name: string): void {
  const previous = live.get(name);
  if (previous) previous();
}

function registerOne(
  api: ModelContextApi,
  registerTool: NonNullable<ModelContextApi["registerTool"]>,
  descriptor: WebMcpToolDescriptor,
  onFailure: (failure: WebMcpRegistrationFailure) => void,
): Unregister {
  const { name } = descriptor;
  retire(name);
  const controller = new AbortController();
  let handle: Unregister | null = null;
  const fail = (cause: BoundaryValue) => {
    onFailure({
      name,
      reason: safeLine(messageOf(cause), "registration_failed"),
    });
  };
  try {
    const returned = registerTool(descriptor, { signal: controller.signal });
    handle = toUnregister(returned);
    if (isThenable(returned)) {
      const pending: Promise<BoundaryValue> = overlapCast(returned);
      pending.then(undefined, (cause: BoundaryValue) => fail(cause));
    }
  } catch (cause) {
    fail(cause instanceof Error ? cause : null);
  }
  let done = false;
  const unregister: Unregister = () => {
    if (done) return;
    done = true;
    if (live.get(name) === unregister) live.delete(name);
    // Every way a browser has offered to end a registration, in case this one
    // offers several: the draft's abort signal, the early builds' method, and
    // the polyfills' returned handle. None of them minds being redundant.
    controller.abort();
    const unregisterTool = api.unregisterTool;
    if (unregisterTool) {
      try {
        unregisterTool(name);
      } catch {
        // A browser that never held the tool has nothing to release.
      }
    }
    if (handle) handle();
  };
  live.set(name, unregister);
  return unregister;
}

/**
 * Registrar over a detected `ModelContextApi`. Names are validated even when
 * the API is absent, so a page misdeclaring a secret-shaped tool fails fast
 * everywhere — not only in browsers that ship WebMCP.
 */
export function createWebMcpRegistrar(
  api: ModelContextApi | null,
  options: WebMcpRegistrarOptions,
): WebMcpRegistrar {
  const { appId } = options;
  const onFailure = options.onFailure ?? (() => {});
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
      const registerTool = api.registerTool;
      if (registerTool) {
        for (const descriptor of descriptors) {
          handles.push(registerOne(api, registerTool, descriptor, onFailure));
        }
      } else if (api.provideContext) {
        for (const name of names) retire(name);
        let cleared = false;
        const clear: Unregister = () => {
          if (cleared) return;
          cleared = true;
          for (const name of names) {
            if (live.get(name) === clear) live.delete(name);
          }
          api.provideContext?.({ description: appId, tools: [] });
        };
        try {
          api.provideContext({ description: appId, tools: descriptors });
          for (const name of names) live.set(name, clear);
          handles.push(clear);
        } catch (cause) {
          const reason = safeLine(
            cause instanceof Error ? cause.message : "",
            "registration_failed",
          );
          for (const name of names) onFailure({ name, reason });
        }
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
 * The current draft answers with a promise and the early builds with an
 * array; both are awaited, so a caller never sees the difference.
 *
 * Every field is copied out of the browser's descriptor, so nothing a caller
 * receives holds a reference to a callable tool. This package intentionally
 * exports no counterpart that invokes `executeTool`: an in-page tutorial agent
 * that can read this list still has no way to run anything in it, and that is
 * the property the absence of such an export enforces.
 */
export async function listRegisteredTools(
  api: ModelContextApi | null,
): Promise<readonly WebMcpToolSummary[]> {
  const getTools = api?.getTools;
  if (!getTools) return [];
  let listed: BoundaryValue;
  try {
    listed = await getTools();
  } catch {
    return [];
  }
  if (!Array.isArray(listed)) return [];
  const summaries: WebMcpToolSummary[] = [];
  for (const entry of listed) {
    const summary = summarizeTool(entry);
    if (summary) summaries.push(summary);
  }
  return summaries;
}
