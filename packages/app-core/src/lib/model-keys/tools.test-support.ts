import type { BoundaryObject } from "@opensesame/os-domain";
import { ModelKeyRefusal } from "./errors.js";
import { ANTHROPIC, GEMINI } from "./harness.test-support.js";
import { type CallProtocol, inspectCall } from "./protocols.js";

/** Tools are priced by the provider outside the tokens a budget counts (ADR 0192 §6). */
export const SCHEMA = {
  type: "object",
  properties: { city: { type: "string" } },
};

export type Case = Readonly<{
  protocol: CallProtocol;
  baseUrl: string;
  path: string;
  /** A body that is in policy, with `extra` fields added to it. */
  body: (extra: BoundaryObject) => BoundaryObject;
  /** A client-side function tool, the only kind a key may carry. */
  tool: BoundaryObject;
  /** The `tools` field that carries it. */
  wrap: (tool: BoundaryObject) => BoundaryObject[];
  /** Tools a provider runs and bills for, each of which must be refused. */
  priced: Readonly<Record<string, BoundaryObject>>;
  /** A way to choose a tool that names nothing but a function. */
  choice: BoundaryObject;
  choiceField: string;
  /** Choices that name a tool a provider runs. */
  pricedChoices: readonly BoundaryObject[];
}>;

export const OPENAI_CASE: Case = {
  protocol: "openai_chat",
  baseUrl: "https://api.openai.com/v1",
  path: "/chat/completions",
  body: (extra) => ({
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 100,
    ...extra,
  }),
  tool: {
    type: "function",
    function: { name: "weather", description: "Weather", parameters: SCHEMA },
  },
  wrap: (tool) => [tool],
  priced: {
    web_search_preview: { type: "web_search_preview" },
    file_search: { type: "file_search", vector_store_ids: ["vs_1"] },
    code_interpreter: { type: "code_interpreter", container: { type: "auto" } },
    computer_use_preview: { type: "computer_use_preview" },
    image_generation: { type: "image_generation" },
    mcp: { type: "mcp", server_url: "https://example.test/mcp" },
  },
  choice: { type: "function", function: { name: "weather" } },
  choiceField: "tool_choice",
  pricedChoices: [
    { type: "web_search_preview" },
    { type: "allowed_tools", allowed_tools: { mode: "auto", tools: [] } },
    { type: "function", function: { name: "weather" }, extra: true },
  ],
};

export const ANTHROPIC_CASE: Case = {
  protocol: "anthropic_messages",
  baseUrl: ANTHROPIC.baseUrl,
  path: "/messages",
  body: (extra) => ({
    model: "claude-sonnet-4",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  }),
  tool: { name: "weather", description: "Weather", input_schema: SCHEMA },
  wrap: (tool) => [tool],
  priced: {
    web_search: { type: "web_search_20250305", name: "web_search" },
    code_execution: { type: "code_execution_20250522", name: "code_execution" },
    computer: { type: "computer_20250124", name: "computer" },
    bash: { type: "bash_20250124", name: "bash" },
    text_editor: { type: "text_editor_20250124", name: "str_replace_editor" },
    web_fetch: { type: "web_fetch_20250910", name: "web_fetch" },
  },
  choice: { type: "tool", name: "weather" },
  choiceField: "tool_choice",
  pricedChoices: [
    { type: "web_search_20250305", name: "web_search" },
    { type: "tool", name: "weather", extra: true },
    { type: "auto", disable_parallel_tool_use: "yes" },
  ],
};

export const GEMINI_CASE: Case = {
  protocol: "gemini_generate_content",
  baseUrl: GEMINI.baseUrl,
  path: "/models/gemini-2.5-flash:generateContent",
  body: (extra) => ({
    contents: [{ parts: [{ text: "hi" }] }],
    generationConfig: { maxOutputTokens: 100 },
    ...extra,
  }),
  tool: {
    function_declarations: [
      { name: "weather", description: "Weather", parameters: SCHEMA },
    ],
  },
  wrap: (tool) => [tool],
  priced: {
    google_search: { google_search: {} },
    google_search_retrieval: { google_search_retrieval: {} },
    googleSearch: { googleSearch: {} },
    code_execution: { code_execution: {} },
    codeExecution: { codeExecution: {} },
    url_context: { url_context: {} },
    google_maps: { google_maps: {} },
    mixed: {
      function_declarations: [{ name: "weather" }],
      google_search: {},
    },
  },
  choice: { function_calling_config: { mode: "ANY" } },
  choiceField: "toolConfig",
  pricedChoices: [
    { retrievalConfig: { latLng: { latitude: 1, longitude: 2 } } },
    { function_calling_config: { mode: "ANY", extra: true } },
    { function_calling_config: { mode: "GOOGLE_SEARCH" } },
  ],
};

export function inspect(c: Case, body: BoundaryObject) {
  return inspectCall({
    protocol: c.protocol,
    baseUrl: c.baseUrl,
    operation: "invoke",
    method: "POST",
    path: c.path,
    body,
  });
}

export function refusalOf(work: () => void): ModelKeyRefusal {
  try {
    work();
  } catch (thrown) {
    if (thrown instanceof ModelKeyRefusal) return thrown;
    throw thrown;
  }
  throw new Error("expected a refusal");
}
