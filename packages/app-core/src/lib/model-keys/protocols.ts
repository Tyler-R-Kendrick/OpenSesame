/**
 * What a model call is, read from the call itself (ADR 0192 §5).
 *
 * A key can be narrowed to a model and to an amount of output only if the
 * broker can find the model and the amount in the request. For each protocol
 * the catalog names, this module knows exactly three things: which routes
 * exist, where the model is, and which request fields may be sent. A field
 * not on the list is refused, because an unlisted field is a feature nobody
 * priced — `n: 100`, a search tool, an audio output — and a budget that cannot
 * see a cost cannot hold it.
 *
 * The caller never names a host or a header. It gives a path relative to the
 * provider's base URL, and the broker forwards the body this module returned,
 * the object it inspected and not a second reading of the caller's bytes.
 */
import {
  type BoundaryObject,
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  isString,
  isTypeofObject,
} from "@opensesame/os-domain";
import { refuse } from "./errors.js";
import { withinSendLimits } from "./request-limits.js";
import { anthropicTools, geminiTools, openaiTools } from "./tools.js";
import { LIMITS, type ModelAction } from "./vocabulary.js";

export type CallProtocol =
  | "openai_chat"
  | "anthropic_messages"
  | "gemini_generate_content";

export type CallOperation = "invoke" | "list";

export type InspectedCall = Readonly<{
  action: ModelAction;
  method: "GET" | "POST";
  /** The base URL and the route: where the broker will send it. */
  url: string;
  model: string | null;
  /** The body to forward, exactly as inspected; `null` for a call with none. */
  body: Readonly<JsonObject> | null;
  /** The most output this call asked for; `null` for a call that generates none. */
  outputTokens: number | null;
  /** A conservative estimate of the input, for reserving a budget. */
  inputEstimate: number;
}>;

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)*$/;
const GEMINI_ROUTE =
  /^\/models\/([A-Za-z0-9][A-Za-z0-9._-]{0,159}):generateContent$/;

const OPENAI_FIELDS = new Set([
  "model",
  "messages",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "stop",
  "seed",
  "presence_penalty",
  "frequency_penalty",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "user",
  "reasoning_effort",
  "stream",
  "n",
]);
const ANTHROPIC_FIELDS = new Set([
  "model",
  "messages",
  "max_tokens",
  "system",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "tools",
  "tool_choice",
  "metadata",
  "thinking",
  "stream",
]);
const GEMINI_FIELDS = new Set([
  "contents",
  "systemInstruction",
  "generationConfig",
  "tools",
  "toolConfig",
  "safetySettings",
]);
const GEMINI_CONFIG_FIELDS = new Set([
  "maxOutputTokens",
  "temperature",
  "topP",
  "topK",
  "stopSequences",
  "candidateCount",
  "responseMimeType",
  "responseSchema",
  "thinkingConfig",
  "seed",
  "presencePenalty",
  "frequencyPenalty",
]);

function plain(value: BoundaryValue, reason: string): JsonObject {
  if (!isJsonObject(value)) return refuse("invalid_request", reason);
  return Object.fromEntries(Object.entries(value));
}

/** One JSON reading of the body, bounded; what is forwarded is this, never the original. */
function jsonBody(body: BoundaryValue): JsonObject {
  let text: string | undefined;
  try {
    text = JSON.stringify(body);
  } catch {
    return refuse("invalid_request", "body.json");
  }
  if (text === undefined) return refuse("invalid_request", "body.json");
  if (new TextEncoder().encode(text).length > LIMITS.maxBodyBytes)
    return refuse("invalid_request", "body.size");
  const parsed = plain(JSON.parse(text), "body.shape");
  withinSendLimits(parsed);
  return parsed;
}

function allowOnly(body: JsonObject, fields: ReadonlySet<string>): void {
  for (const key of Object.keys(body)) {
    if (!fields.has(key)) refuse("insufficient_scope", "body.field");
  }
}

function tokenCount(value: BoundaryValue, reason: string): number {
  if (!isNumber(value) || !Number.isSafeInteger(value) || value < 1)
    return refuse("invalid_request", reason);
  return value;
}

function messages(body: JsonObject, field: string): void {
  const list = body[field];
  if (!Array.isArray(list) || list.length === 0)
    refuse("invalid_request", "body.messages");
}

function modelOf(body: JsonObject): string {
  const model = body.model;
  if (!isString(model) || !MODEL_ID.test(model))
    return refuse("invalid_request", "body.model");
  return model;
}

function notStreamed(body: JsonObject): void {
  if (body.stream !== undefined && body.stream !== false)
    refuse("insufficient_scope", "body.stream");
}

function openaiChat(body: JsonObject) {
  allowOnly(body, OPENAI_FIELDS);
  openaiTools(body);
  notStreamed(body);
  if (body.n !== undefined && body.n !== 1)
    refuse("insufficient_scope", "body.n");
  messages(body, "messages");
  const asked = [body.max_tokens, body.max_completion_tokens]
    .filter((value) => value !== undefined)
    .map((value) => tokenCount(value, "body.max_tokens"));
  if (asked.length === 0)
    return refuse("insufficient_scope", "tokens.required");
  return { model: modelOf(body), outputTokens: Math.max(...asked) };
}

function anthropicMessages(body: JsonObject) {
  allowOnly(body, ANTHROPIC_FIELDS);
  anthropicTools(body);
  notStreamed(body);
  messages(body, "messages");
  const outputTokens = tokenCount(body.max_tokens, "body.max_tokens");
  if (body.thinking !== undefined) {
    const thinking = plain(body.thinking, "body.thinking");
    for (const key of Object.keys(thinking)) {
      if (key !== "type" && key !== "budget_tokens")
        refuse("insufficient_scope", "body.thinking");
    }
    const budget = thinking.budget_tokens;
    if (
      budget !== undefined &&
      tokenCount(budget, "body.thinking") > outputTokens
    )
      refuse("insufficient_scope", "body.thinking");
  }
  return { model: modelOf(body), outputTokens };
}

function geminiGenerate(body: JsonObject, model: string) {
  allowOnly(body, GEMINI_FIELDS);
  geminiTools(body);
  if (!Array.isArray(body.contents) || body.contents.length === 0)
    refuse("invalid_request", "body.contents");
  const config = plain(body.generationConfig, "body.generationConfig");
  allowOnly(config, GEMINI_CONFIG_FIELDS);
  if (config.candidateCount !== undefined && config.candidateCount !== 1)
    refuse("insufficient_scope", "body.n");
  const outputTokens = tokenCount(
    config.maxOutputTokens,
    "body.maxOutputTokens",
  );
  if (config.thinkingConfig !== undefined) {
    const thinking = plain(config.thinkingConfig, "body.thinking");
    for (const key of Object.keys(thinking)) {
      if (key !== "thinkingBudget")
        refuse("insufficient_scope", "body.thinking");
    }
    const budget = thinking.thinkingBudget;
    if (
      budget !== undefined &&
      (!isNumber(budget) ||
        !Number.isSafeInteger(budget) ||
        budget < 0 ||
        budget > outputTokens)
    )
      refuse("insufficient_scope", "body.thinking");
  }
  return { model, outputTokens };
}

function route(path: BoundaryValue): string {
  if (!isString(path) || path.length > 256 || !SAFE_PATH.test(path))
    return refuse("insufficient_scope", "call.route");
  for (const segment of path.split("/")) {
    if (segment === "." || segment === "..")
      return refuse("insufficient_scope", "call.route");
  }
  return path;
}

function estimate(body: JsonObject): number {
  return Math.ceil(new TextEncoder().encode(JSON.stringify(body)).length / 3);
}

export function inspectCall(call: {
  protocol: CallProtocol;
  baseUrl: string;
  operation: CallOperation;
  method: string;
  path: string;
  body?: BoundaryValue;
}): InspectedCall {
  const path = route(call.path);
  const url = `${call.baseUrl}${path}`;
  if (call.operation === "list") {
    if (
      call.method !== "GET" ||
      path !== "/models" ||
      (call.body ?? null) !== null
    )
      return refuse("insufficient_scope", "call.route");
    return {
      action: "model.list",
      method: "GET",
      url,
      model: null,
      body: null,
      outputTokens: null,
      inputEstimate: 0,
    };
  }
  if (call.method !== "POST") return refuse("insufficient_scope", "call.route");
  const body = jsonBody(call.body);
  let found: { model: string; outputTokens: number };
  if (call.protocol === "gemini_generate_content") {
    const model = GEMINI_ROUTE.exec(path)?.[1];
    if (model === undefined) return refuse("insufficient_scope", "call.route");
    found = geminiGenerate(body, model);
  } else if (call.protocol === "openai_chat") {
    if (path !== "/chat/completions")
      return refuse("insufficient_scope", "call.route");
    found = openaiChat(body);
  } else {
    if (path !== "/messages") return refuse("insufficient_scope", "call.route");
    found = anthropicMessages(body);
  }
  return {
    action: "model.invoke",
    method: "POST",
    url,
    model: found.model,
    body,
    outputTokens: found.outputTokens,
    inputEstimate: estimate(body),
  };
}

/** An object's own fields, an array's indices included; anything else has none. */
function ownFields(value: BoundaryValue): BoundaryObject | null {
  if (value === null || !isTypeofObject(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

function count(value: BoundaryValue): number | null {
  return isNumber(value) && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function readUsage(
  holder: BoundaryValue,
  input: string,
  output: string,
): { input: number; output: number } | null {
  const fields = ownFields(holder);
  if (fields === null) return null;
  const a = count(fields[input]);
  const b = count(fields[output]);
  return a === null || b === null ? null : { input: a, output: b };
}

/** Token usage a provider reports in its answer, when it reports it. */
export function reportedUsage(
  protocol: CallProtocol,
  answer: BoundaryValue,
): { input: number; output: number } | null {
  const usage = ownFields(answer);
  if (usage === null) return null;
  if (protocol === "gemini_generate_content")
    return readUsage(
      usage.usageMetadata,
      "promptTokenCount",
      "candidatesTokenCount",
    );
  if (protocol === "anthropic_messages")
    return readUsage(usage.usage, "input_tokens", "output_tokens");
  return readUsage(usage.usage, "prompt_tokens", "completion_tokens");
}
