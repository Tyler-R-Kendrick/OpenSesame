import { afterEach, expect, it, vi } from "vitest";
import { bindHostedModelAuthority } from "../hosted-model-authority.js";
import {
  NO_MODEL_PROVIDER,
  loadModelProvider,
  saveModelProvider,
  withInference,
} from "../model-provider-record.js";
import {
  choiceFromSlug,
  choiceToSlug,
  inferenceSlugOptions,
} from "../model-slugs.js";
import { installNativeApiTests } from "../native-api.test-support.js";
import { replicateOperationInput } from "./replicate-inference.js";

installNativeApiTests();
let release = () => {};
afterEach(() => release());

it("selects and persists an exact saved AI connection when providers and model names repeat", async () => {
  const first = "native-ai-00000000-0000-4000-8000-000000000001";
  const second = "native-ai-00000000-0000-4000-8000-000000000002";
  release = bindHostedModelAuthority({
    fetch: vi.fn(),
    assertCurrent: vi.fn(),
    execute: vi.fn(),
    read: () => null,
    connections: () => [
      {
        connectionId: first,
        providerId: "byo-ai",
        status: "connected",
        method: "api-key",
        endpoint: "https://one.example/v1",
        model: "shared-model",
        name: "First endpoint",
      },
      {
        connectionId: second,
        providerId: "byo-ai",
        status: "connected",
        method: "api-key",
        endpoint: "https://two.example/v1",
        model: "shared-model",
        name: "Second endpoint",
      },
    ],
  });
  const options = inferenceSlugOptions({
    browserReady: false,
    connectedProviderIds: [],
  });
  const choice = choiceFromSlug(`connection:${second}`, options);
  if (!choice) throw new Error("Missing saved BYO AI option");
  expect(choice).toMatchObject({
    connectionId: second,
    endpoint: "https://two.example/v1",
    model: "shared-model",
  });
  await saveModelProvider(withInference(NO_MODEL_PROVIDER, choice));
  expect(loadModelProvider().inference).toEqual(choice);
  expect(choiceToSlug(loadModelProvider().inference)).toBe(
    `connection:${second}`,
  );
});

it("keeps native and BYO transcription and model-specific predictions out of text inference choices while preserving conversational and legacy providers", () => {
  const nativeSpeech = "native-speech-selection";
  const byoSpeech = "byo-speech-selection";
  const prediction = "prediction-selection";
  const byoPrediction = "byo-prediction-selection";
  const bedrock = "bedrock-conversation-selection";
  const text = "text-selection";
  const legacy = "legacy-selection";
  const connections = [
    {
      connectionId: nativeSpeech,
      providerId: "elevenlabs",
      family: "elevenlabs_scribe" as const,
      status: "connected",
      method: "api-key",
      model: "scribe_v2",
      endpoint: "https://api.elevenlabs.io/v1",
    },
    {
      connectionId: byoSpeech,
      providerId: "byo-ai",
      family: "elevenlabs_scribe" as const,
      status: "connected",
      method: "api-key",
      model: "custom-speech-model",
      endpoint: "https://operator.example/speech",
    },
    {
      connectionId: prediction,
      providerId: "replicate",
      family: "replicate_predictions" as const,
      status: "connected",
      method: "api-key",
      model: "owner/model",
      endpoint: "https://api.replicate.com/v1",
    },
    {
      connectionId: byoPrediction,
      providerId: "byo-ai",
      family: "replicate_predictions" as const,
      status: "connected",
      method: "api-key",
      model: "owner/model",
      endpoint: "https://operator.example/predictions",
    },
    {
      connectionId: bedrock,
      providerId: "aws-bedrock",
      family: "bedrock_converse" as const,
      status: "connected",
      method: "api-key",
      model: "conversation-model",
      endpoint: "https://bedrock-runtime.us-east-1.amazonaws.com",
    },
    {
      connectionId: text,
      providerId: "byo-ai",
      family: "openai_responses" as const,
      status: "connected",
      method: "api-key",
      model: "custom-text-model",
      endpoint: "https://operator.example/text",
    },
    {
      connectionId: legacy,
      providerId: "openai",
      status: "connected",
      method: "api-key",
      model: "legacy-model",
      endpoint: "https://api.openai.com/v1",
    },
  ];
  release = bindHostedModelAuthority({
    fetch: vi.fn(),
    assertCurrent: vi.fn(),
    execute: vi.fn(),
    read: (id) => connections.find((row) => row.connectionId === id) ?? null,
    connections: () => connections,
  });
  const options = inferenceSlugOptions({
    browserReady: false,
    connectedProviderIds: [],
  });
  expect(
    options
      .filter((option) => option.value.startsWith("connection:"))
      .map((option) => option.value),
  ).toEqual([bedrock, text, legacy].map((id) => `connection:${id}`));
  for (const id of [nativeSpeech, byoSpeech, prediction, byoPrediction])
    expect(choiceFromSlug(`connection:${id}`, options)).toBeNull();
  for (const id of [bedrock, text, legacy])
    expect(choiceFromSlug(`connection:${id}`, options)).toMatchObject({
      connectionId: id,
    });
  expect(options[0]?.label).toBe("None");
});

it.each([
  {
    messages: [
      {
        role: "system" as const,
        content: "Interpret this command and return structured intent.",
      },
      { role: "user" as const, content: "Find the saved account" },
    ],
  },
  { messages: [{ role: "user" as const, content: "Find the saved account" }] },
])(
  "actual prediction parser rejects standard command-bar chat, not the provider's dedicated JSON operation %#",
  ({ messages }) => {
    expect(() =>
      replicateOperationInput({ model: "owner/model", messages }),
    ).toThrow("model-specific prediction input JSON");
    expect(
      replicateOperationInput({
        model: "owner/model",
        messages: [
          {
            role: "user",
            content: '{"subject":"Dedicated prediction input","iterations":1}',
          },
        ],
      }),
    ).toEqual({ subject: "Dedicated prediction input", iterations: 1 });
  },
);
