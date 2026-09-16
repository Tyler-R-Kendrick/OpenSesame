/**
 * AI model catalog — voice (STT) and inference (LLM) presets offered in
 * deployment setup › AI and Settings › AI models. Addresses and model ids only;
 * never an API key (ADR 0114).
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
  /**
   * Named variants the operator can pick. Empty means a free-text model field
   * (or no model field for the browser Prompt API).
   */
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
 * Inference / LLM catalog. Local first (nothing leaves), then hosted, with the
 * browser Prompt API offered separately by the panel when the device is ready.
 */
export const INFERENCE_MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    id: "ollama",
    kind: "local",
    name: "Ollama",
    kindLabel: "nothing leaves",
    endpoint: "http://127.0.0.1:11434",
    model: "qwen2.5-vl:7b",
    models: [],
  },
  {
    id: "lmstudio",
    kind: "local",
    name: "LM Studio",
    kindLabel: "nothing leaves",
    endpoint: "http://127.0.0.1:1234/v1",
    model: "qwen2.5-vl-7b",
    models: [],
  },
  {
    id: "anthropic",
    kind: "hosted",
    name: "Anthropic",
    kindLabel: "api key",
    endpoint: "https://api.anthropic.com",
    model: "claude-sonnet-5",
    models: [],
  },
  {
    id: "openai",
    kind: "hosted",
    name: "OpenAI",
    kindLabel: "api key",
    endpoint: "https://api.openai.com/v1",
    model: "",
    models: [],
  },
  {
    id: "openai-shaped",
    kind: "hosted",
    name: "Anything OpenAI-shaped",
    kindLabel: "bring a url",
    endpoint: "",
    model: "",
    models: [],
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
