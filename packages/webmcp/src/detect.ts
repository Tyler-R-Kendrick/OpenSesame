/**
 * Feature detection for the W3C Web Model Context proposal
 * (`navigator.modelContext`). No shipping browser exposes it stably, so the
 * types below model only the slice this package uses, and every caller must
 * tolerate `null` — absence of the API means every registration no-ops.
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

/**
 * Normalized view over whichever methods the host browser implements. Each
 * present method is pre-bound to the underlying `modelContext` object.
 */
export type ModelContextApi = {
  registerTool?: (tool: WebMcpToolDescriptor) => BoundaryValue;
  provideContext?: (context: ProvideContextInput) => BoundaryValue;
};

export function detectModelContext(): ModelContextApi | null {
  const globals: BoundaryObject = overlapCast(globalThis);
  const navigatorValue = globals.navigator;
  if (
    navigatorValue === null ||
    navigatorValue === undefined ||
    !isTypeofObject(navigatorValue) ||
    Array.isArray(navigatorValue)
  ) {
    return null;
  }
  const navigatorObject: BoundaryObject = overlapCast(navigatorValue);
  const candidate = navigatorObject.modelContext;
  if (
    candidate === null ||
    candidate === undefined ||
    !isTypeofObject(candidate) ||
    Array.isArray(candidate)
  ) {
    return null;
  }
  const modelContext: BoundaryObject = overlapCast(candidate);
  const registerToolValue = modelContext.registerTool;
  const provideContextValue = modelContext.provideContext;
  const api: ModelContextApi = {};
  if (isFunction(registerToolValue)) {
    const registerTool: (tool: WebMcpToolDescriptor) => BoundaryValue =
      overlapCast(registerToolValue);
    api.registerTool = (tool) => registerTool.call(modelContext, tool);
  }
  if (isFunction(provideContextValue)) {
    const provideContext: (context: ProvideContextInput) => BoundaryValue =
      overlapCast(provideContextValue);
    api.provideContext = (context) =>
      provideContext.call(modelContext, context);
  }
  if (!api.registerTool && !api.provideContext) {
    return null;
  }
  return api;
}
