/**
 * AI model catalog — voice (STT) and inference (LLM) presets. Addresses and
 * model ids only; never an API key (ADR 0114). Hosted entries are offered in
 * Settings › Models only after Agent Harnesses has an active connection.
 */

import type { ModelPlaneKind } from "./model-provider.js";

export type ModelCatalogEntry = {
  readonly id: string;
  readonly kind: ModelPlaneKind;
  readonly name: string;
  readonly kindLabel: string;
  readonly endpoint: string;
  /** Default model id or BCP-47 speech language. */
  readonly model: string;
  /** Named variants the operator can pick as `provider/model` slugs. */
  readonly models: readonly string[];
};

/**
 * Voice / speech-to-text catalog. Today the browser's own Web Speech engine is
 * the only plane; `models` are recognition languages, not weight names.
 */
export const VOICE_MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    id: "browser-speech",
    kind: "browser",
    name: "Browser speech",
    kindLabel: "this device",
    endpoint: "",
    model: "en-US",
    models: [
      "en-US",
      "en-GB",
      "en-AU",
      "es-ES",
      "es-MX",
      "fr-FR",
      "de-DE",
      "it-IT",
      "pt-BR",
      "nl-NL",
      "pl-PL",
      "ru-RU",
      "sv-SE",
      "tr-TR",
      "ja-JP",
      "ko-KR",
      "zh-CN",
      "zh-TW",
      "hi-IN",
      "ar-SA",
    ],
  },
];

/**
 * Inference / LLM catalog. Local first (nothing leaves), then hosted Agent
 * Harness providers. The browser Prompt API is offered separately when ready.
 */
export const INFERENCE_MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    id: "ollama",
    kind: "local",
    name: "Ollama",
    kindLabel: "nothing leaves",
    endpoint: "http://127.0.0.1:11434",
    model: "qwen2.5-vl:7b",
    models: ["qwen2.5-vl:7b", "llama3.2", "mistral"],
  },
  {
    id: "lmstudio",
    kind: "local",
    name: "LM Studio",
    kindLabel: "nothing leaves",
    endpoint: "http://127.0.0.1:1234/v1",
    model: "qwen2.5-vl-7b",
    models: ["qwen2.5-vl-7b"],
  },
  {
    id: "anthropic",
    kind: "hosted",
    name: "Anthropic",
    kindLabel: "api key",
    endpoint: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    models: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
  },
  {
    id: "openai",
    kind: "hosted",
    name: "OpenAI",
    kindLabel: "api key",
    endpoint: "https://api.openai.com/v1",
    model: "gpt-4o",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini"],
  },
  {
    id: "azure-openai",
    kind: "hosted",
    name: "Azure OpenAI",
    kindLabel: "configuration",
    endpoint: "",
    model: "gpt-4o",
    models: ["gpt-4o", "gpt-4o-mini"],
  },
  {
    id: "aws-bedrock",
    kind: "hosted",
    name: "AWS Bedrock",
    kindLabel: "configuration",
    endpoint: "",
    model: "anthropic.claude-sonnet-4-5",
    models: ["anthropic.claude-sonnet-4-5", "amazon.nova-pro-v1:0"],
  },
  {
    id: "openrouter",
    kind: "hosted",
    name: "OpenRouter",
    kindLabel: "oauth",
    endpoint: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o",
    models: ["openai/gpt-4o", "anthropic/claude-sonnet-4.5"],
  },
  {
    id: "huggingface",
    kind: "hosted",
    name: "Hugging Face",
    kindLabel: "api key",
    endpoint: "https://router.huggingface.co/v1",
    model: "meta-llama/Llama-3.3-70B-Instruct",
    models: ["meta-llama/Llama-3.3-70B-Instruct"],
  },
];

/** Browser Prompt API entry — offered only when the capability probe is ready. */
export const BROWSER_INFERENCE_ENTRY = {
  id: "browser",
  kind: "browser",
  name: "This device's own model",
  kindLabel: "in the browser",
  endpoint: "",
  model: "",
  models: [],
} as const satisfies ModelCatalogEntry;

/** @deprecated Prefer INFERENCE_MODEL_CATALOG — kept for existing imports. */
export const MODEL_PROVIDER_PRESETS = INFERENCE_MODEL_CATALOG;

export type ModelProviderPreset = ModelCatalogEntry;

export function catalogEntry(
  catalog: readonly ModelCatalogEntry[],
  id: string,
): ModelCatalogEntry | null {
  return catalog.find((entry) => entry.id === id) ?? null;
}
