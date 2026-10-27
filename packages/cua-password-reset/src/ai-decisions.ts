import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { type LanguageModel, generateObject } from "ai";
import { z } from "zod";
import { type DecisionsApi, decide, modelObservation } from "./decisions.js";
import { type Observation, decisionSchema } from "./types.js";

export interface AiDecisionConfig {
  model: string;
  baseURL: string;
  apiKey: () => string | Promise<string>;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

type ModelConfig = {
  name: "opensesame-cua-password-reset";
  baseURL: string;
  apiKey: string;
  fetch: typeof fetch;
};

type GenerateInput = {
  model: LanguageModel;
  schema: typeof decisionSchema;
  schemaName: "password_reset_decision";
  system: string;
  prompt: string;
  maxOutputTokens: number;
  abortSignal: AbortSignal;
};

export interface AiDecisionRuntime {
  generate(options: GenerateInput): Promise<{ object: unknown }>;
  createModel(config: ModelConfig, model: string): LanguageModel;
}

const configSchema = z
  .object({
    model: z.string().min(1).max(200),
    baseURL: z.url(),
    apiKey: z.custom<() => string | Promise<string>>(
      (value) => typeof value === "function",
    ),
    timeoutMs: z.number().int().min(1).max(120_000).optional(),
    maxOutputTokens: z.number().int().min(1).max(8_192).optional(),
  })
  .strict();

const SYSTEM =
  "Choose exactly one supplied password-reset decision. Return no other fields.";

function validatedConfig(config: AiDecisionConfig) {
  const parsed = configSchema.parse(config);
  const url = new URL(parsed.baseURL);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Model baseURL must be a credential-free HTTP(S) URL");
  return parsed;
}

async function safeModelFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, { ...init, redirect: "error" });
  if (response.status >= 300 && response.status < 400)
    throw new Error("Model endpoint redirected");
  return response;
}

function safeObservation(input: Observation): Observation {
  const observation = modelObservation(input);
  const secrets = input.sensitiveValues ?? [];
  return {
    id: observation.id,
    origin: observation.origin,
    fields: observation.fields.map((field) => ({
      ...field,
      label: secrets.reduce(
        (label, secret) => label.split(secret).join("[redacted]"),
        field.label,
      ),
    })),
    ...(observation.maskedScreenshot === undefined
      ? {}
      : { maskedScreenshot: observation.maskedScreenshot }),
  };
}

function runtime(overrides: Partial<AiDecisionRuntime>): AiDecisionRuntime {
  return {
    generate: async (options) => generateObject(options),
    createModel: (config, model) => createOpenAICompatible(config)(model),
    ...overrides,
  };
}

class AiDecisions implements DecisionsApi {
  constructor(
    private readonly config: ReturnType<typeof validatedConfig>,
    private readonly sdk: AiDecisionRuntime,
  ) {}

  async decide(input: Parameters<DecisionsApi["decide"]>[0]): Promise<unknown> {
    const observation = safeObservation(input.observation);
    try {
      const apiKey = await this.config.apiKey();
      if (!apiKey) throw new Error("empty key");
      const result = await this.sdk.generate({
        model: this.sdk.createModel(
          {
            name: "opensesame-cua-password-reset",
            baseURL: this.config.baseURL,
            apiKey,
            fetch: safeModelFetch,
          },
          this.config.model,
        ),
        schema: decisionSchema,
        schemaName: "password_reset_decision",
        system: SYSTEM,
        prompt: JSON.stringify({ observation, candidates: input.candidates }),
        maxOutputTokens: this.config.maxOutputTokens ?? 1_024,
        abortSignal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000),
      });
      return result.object;
    } catch {
      throw new Error("Model decision request failed");
    }
  }
}

const PROBE_ORIGIN = "https://configuration.invalid";

export async function createAiDecisions(
  config: AiDecisionConfig,
  sdk: Partial<AiDecisionRuntime> = {},
): Promise<DecisionsApi> {
  const api = new AiDecisions(validatedConfig(config), runtime(sdk));
  const observation: Observation = {
    id: "configuration-probe",
    origin: PROBE_ORIGIN,
    fields: [{ ref: "e1", kind: "button", label: "Continue" }],
  };
  try {
    await decide(api, observation, [PROBE_ORIGIN]);
  } catch {
    throw new Error("Model failed its strict decision probe");
  }
  return api;
}
