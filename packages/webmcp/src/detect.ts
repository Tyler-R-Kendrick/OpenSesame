/**
 * Feature detection for the Web Model Context (WebMCP) draft.
 *
 * The current draft and the browser builds that implement it hang the object
 * off `document.modelContext` and define `registerTool`, `getTools` and
 * `executeTool`. An earlier revision of the same proposal put it on
 * `navigator.modelContext` with `registerTool`/`provideContext`, and builds
 * that shipped against that revision are still in the wild — so the legacy
 * location is probed second, deliberately, rather than dropped. Nothing above
 * this module ever branches on which one answered: both normalize to one
 * `ModelContextApi` whose methods are pre-bound to the object they came from.
 *
 * The types model only the slice this package uses, and every caller must
 * tolerate `null`. Absence of the API means every registration no-ops, which
 * keeps WebMCP progressive enhancement — never a requirement for the page to
 * work, and never a reason to gate a feature on an experimental browser.
 */

import {
  type BoundaryObject,
  type BoundaryValue,
  type JsonObject,
  isFunction,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";

export type WebMcpTextContent = { type: "text"; text: string };

export type WebMcpToolResult = {
  content: WebMcpTextContent[];
  isError?: boolean;
};

export type WebMcpToolDescriptor = {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: JsonObject;
  execute: (args: JsonObject) => Promise<WebMcpToolResult>;
};

export type Unregister = () => void;

export type ProvideContextInput = {
  description?: string;
  tools?: WebMcpToolDescriptor[];
};

/** Which of the two draft locations answered the probe. */
export type ModelContextSource = "document" | "navigator";

/**
 * Probe order: the current draft location wins over the legacy one whenever
 * both are present.
 */
const MODEL_CONTEXT_SOURCES: readonly ModelContextSource[] = [
  "document",
  "navigator",
] as const;

/**
 * Normalized view over whichever methods the host browser implements. Each
 * present method is pre-bound to the underlying `modelContext` object.
 *
 * `executeTool` is bound because a browser that has it will run OpenSesame's
 * tools through it either way, and hiding that from the detector would only
 * hide it from us. This package deliberately exports no function that calls
 * it — see `registrar.ts`.
 */
export type ModelContextApi = {
  source?: ModelContextSource;
  registerTool?: (tool: WebMcpToolDescriptor) => BoundaryValue;
  provideContext?: (context: ProvideContextInput) => BoundaryValue;
  getTools?: () => BoundaryValue;
  executeTool?: (name: string, args: JsonObject) => BoundaryValue;
};

/** What `detectModelContext` returns: an api that always names its origin. */
export type DetectedModelContext = ModelContextApi & {
  source: ModelContextSource;
};

function objectMember(
  container: BoundaryObject,
  key: string,
): BoundaryObject | null {
  const value = container[key];
  if (
    value === null ||
    value === undefined ||
    !isTypeofObject(value) ||
    Array.isArray(value)
  ) {
    return null;
  }
  const member: BoundaryObject = overlapCast(value);
  return member;
}

function bind(
  modelContext: BoundaryObject,
  source: ModelContextSource,
): DetectedModelContext | null {
  const api: DetectedModelContext = { source };
  const registerToolValue = modelContext.registerTool;
  if (isFunction(registerToolValue)) {
    const registerTool: (tool: WebMcpToolDescriptor) => BoundaryValue =
      overlapCast(registerToolValue);
    api.registerTool = (tool) => registerTool.call(modelContext, tool);
  }
  const provideContextValue = modelContext.provideContext;
  if (isFunction(provideContextValue)) {
    const provideContext: (context: ProvideContextInput) => BoundaryValue =
      overlapCast(provideContextValue);
    api.provideContext = (context) =>
      provideContext.call(modelContext, context);
  }
  const getToolsValue = modelContext.getTools;
  if (isFunction(getToolsValue)) {
    const getTools: () => BoundaryValue = overlapCast(getToolsValue);
    api.getTools = () => getTools.call(modelContext);
  }
  const executeToolValue = modelContext.executeTool;
  if (isFunction(executeToolValue)) {
    const executeTool: (name: string, args: JsonObject) => BoundaryValue =
      overlapCast(executeToolValue);
    api.executeTool = (name, args) =>
      executeTool.call(modelContext, name, args);
  }
  if (
    !api.registerTool &&
    !api.provideContext &&
    !api.getTools &&
    !api.executeTool
  ) {
    return null;
  }
  return api;
}

/**
 * Returns `null` when no implementation is reachable. A `modelContext` object
 * that carries none of the four methods counts as no implementation, and the
 * probe continues to the next source rather than settling for it — a stub on
 * `document` must not mask a working legacy `navigator` object.
 */
export function detectModelContext(): DetectedModelContext | null {
  const globals: BoundaryObject = overlapCast(globalThis);
  for (const source of MODEL_CONTEXT_SOURCES) {
    const host = objectMember(globals, source);
    if (!host) continue;
    const modelContext = objectMember(host, "modelContext");
    if (!modelContext) continue;
    const api = bind(modelContext, source);
    if (api) return api;
  }
  return null;
}
