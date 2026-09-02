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

/**
 * The draft's `ToolAnnotations`: hints a browser agent may read before it
 * decides to call a tool. `readOnlyHint` is the one this package sets, and it
 * is a declaration by the page — it grants nothing and withholds nothing.
 */
export type WebMcpToolAnnotations = {
  readOnlyHint?: boolean;
};

export type WebMcpToolDescriptor = {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: JsonObject;
  annotations?: WebMcpToolAnnotations;
  execute: (args: JsonObject) => Promise<WebMcpToolResult>;
};

/**
 * The draft's `ModelContextRegisterToolOptions`. The current spec has no
 * `unregisterTool` at all: aborting the signal handed to `registerTool` is the
 * only way a registration ends, so the registrar always passes one.
 */
export type RegisterToolOptions = {
  signal: AbortSignal;
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
  /**
   * Returns whatever the browser returns: `undefined` on the early builds, a
   * promise on the current draft (which rejects for a duplicate name), or a
   * handle on the polyfills. The registrar tolerates every one of them.
   */
  registerTool?: (
    tool: WebMcpToolDescriptor,
    options?: RegisterToolOptions,
  ) => BoundaryValue;
  /** Present on the early Chrome builds and the polyfills; absent in the draft. */
  unregisterTool?: (name: string) => BoundaryValue;
  provideContext?: (context: ProvideContextInput) => BoundaryValue;
  /** An array on the early builds, a promise of one on the current draft. */
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
    const registerTool: (
      tool: WebMcpToolDescriptor,
      options?: RegisterToolOptions,
    ) => BoundaryValue = overlapCast(registerToolValue);
    api.registerTool = (tool, options) =>
      options === undefined
        ? registerTool.call(modelContext, tool)
        : registerTool.call(modelContext, tool, options);
  }
  const unregisterToolValue = modelContext.unregisterTool;
  if (isFunction(unregisterToolValue)) {
    const unregisterTool: (name: string) => BoundaryValue =
      overlapCast(unregisterToolValue);
    api.unregisterTool = (name) => unregisterTool.call(modelContext, name);
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
