/** Closed hosted-model protocols. Inputs never select an origin or HTTP header. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";

const Message = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().min(1).max(8192),
  })
  .strict();
const Input = z
  .object({
    model: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9._:/-]+$/),
    messages: z.array(Message).min(1).max(16),
    maxOutputTokens: z.number().int().min(1).max(4096).optional(),
  })
  .strict();
export type HostedModelInput = z.infer<typeof Input>;
export type HostedModelResult = {
  providerId: string;
  model: string;
  answer: string;
};
type AnthropicBody = {
  model: string;
  messages: HostedModelInput["messages"];
  max_tokens: number;
  system?: string;
};
type GeminiContent = { role: "model" | "user"; parts: { text: string }[] };
type GeminiBody = {
  contents: GeminiContent[];
  generationConfig: { maxOutputTokens: number };
  systemInstruction?: { parts: { text: string }[] };
};
type ChatBody = {
  model: string;
  messages: HostedModelInput["messages"];
  stream: false;
  max_tokens?: number;
  max_completion_tokens?: number;
};
type HostedModelBody = AnthropicBody | GeminiBody | ChatBody;
export type HostedModelRequest = { url: string; body: HostedModelBody };
export const HOSTED_MODEL_PROVIDERS = [
  "anthropic",
  "openai",
  "openrouter",
  "huggingface",
  "gemini",
] as const;
export type HostedModelProvider = (typeof HOSTED_MODEL_PROVIDERS)[number];
export function isHostedModelProvider(id: string): id is HostedModelProvider {
  return HOSTED_MODEL_PROVIDERS.some((provider) => provider === id);
}

function anthropic(input: HostedModelInput): HostedModelRequest {
  const system = input.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  const messages = input.messages.filter(
    (message) => message.role !== "system",
  );
  if (!messages.length) throw new Error("Enter a model question");
  const body: AnthropicBody = {
    model: input.model,
    messages,
    max_tokens: input.maxOutputTokens ?? 1024,
  };
  if (system) body.system = system;
  return { url: "https://api.anthropic.com/v1/messages", body };
}
function gemini(input: HostedModelInput): HostedModelRequest {
  if (!/^[A-Za-z0-9._-]+$/.test(input.model))
    throw new Error("Select a valid Gemini model identifier");
  const system = input.messages
    .filter((message) => message.role === "system")
    .map((message) => ({ text: message.content }));
  const contents = input.messages
    .filter((message) => message.role !== "system")
    .map(
      (message): GeminiContent => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      }),
    );
  if (!contents.length) throw new Error("Enter a model question");
  const body: GeminiBody = {
    contents,
    generationConfig: { maxOutputTokens: input.maxOutputTokens ?? 1024 },
  };
  if (system.length) body.systemInstruction = { parts: system };
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${input.model}:generateContent`,
    body,
  };
}
const CHAT_URLS = {
  openai: "https://api.openai.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  huggingface: "https://router.huggingface.co/v1/chat/completions",
} as const;
export function hostedModelRequest(
  provider: HostedModelProvider,
  supplied: HostedModelInput,
): HostedModelRequest {
  const input = Input.parse(supplied);
  if (new TextEncoder().encode(JSON.stringify(input)).length > 32768)
    throw new Error("Model request is too large");
  if (provider === "anthropic") return anthropic(input);
  if (provider === "gemini") return gemini(input);
  const body: ChatBody = {
    model: input.model,
    messages: input.messages,
    stream: false,
  };
  if (provider === "openai")
    body.max_completion_tokens = input.maxOutputTokens ?? 1024;
  else body.max_tokens = input.maxOutputTokens ?? 1024;
  return { url: CHAT_URLS[provider], body };
}

const Text = z.string().max(32768);
const AnthropicReply = z.object({
  type: z.literal("message"),
  content: z.array(
    z.union([
      z.object({ type: z.literal("text"), text: Text }),
      z.object({ type: z.literal("thinking") }),
      z.object({ type: z.literal("tool_use") }),
    ]),
  ),
});
const ChatReply = z.object({
  choices: z.array(z.object({ message: z.object({ content: Text }) })).min(1),
});
const GeminiReply = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({ parts: z.array(z.object({ text: Text })) }),
      }),
    )
    .min(1),
});
function answer(provider: HostedModelProvider, value: BoundaryValue): string {
  if (provider === "anthropic")
    return AnthropicReply.parse(value)
      .content.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  if (provider === "gemini")
    return (
      GeminiReply.parse(value)
        .candidates[0]?.content.parts.map((part) => part.text)
        .join("\n") ?? ""
    );
  return ChatReply.parse(value).choices[0]?.message.content ?? "";
}
export function hostedModelAnswer(
  provider: HostedModelProvider,
  value: BoundaryValue,
): string {
  try {
    z.object({
      error: z.undefined().optional(),
      errors: z.undefined().optional(),
    }).parse(value);
    const text = answer(provider, value).trim();
    if (!text || text.length > 32768) throw new Error("Empty answer");
    return text;
  } catch {
    throw new Error("The model did not return a valid text answer");
  }
}
