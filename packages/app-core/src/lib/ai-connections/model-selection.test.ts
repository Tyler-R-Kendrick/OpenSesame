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
