import { expect, it } from "vitest";
import { hostedModelRequest } from "../hosted-model-protocol.js";
import { aiConnectionBinding, validateAiConnection } from "./configuration.js";
import { inferAiConnection } from "./inference.js";
import { aiConnectionFamilies, aiConnectionPreset } from "./presets.js";
import {
  aiConnectionHeaders,
  aiInferenceAnswer,
  aiInferenceRequest,
} from "./protocol.js";
import { ownedSpeechAudio } from "./speech-tls.test-support.js";
import { readAiTextStream } from "./stream.js";
import type { AiConnectionDraft } from "./types.js";

const draft: AiConnectionDraft = {
  providerId: "elevenlabs",
  name: "Local transcription",
  family: "elevenlabs_scribe",
  baseUrl: "https://api.elevenlabs.io/v1",
  model: "scribe_v2",
  authentication: "api-key",
  apiKey: "owned-scribe-configuration-key",
  tokenParameter: "max_tokens",
};
it.each(["elevenlabs", "byo-ai"])(
  "validates public %s speech through the single shared preset catalog",
  (providerId) => {
    expect(validateAiConnection({ ...draft, providerId })).toEqual({
      ...draft,
      providerId,
    });
    expect(aiConnectionPreset("elevenlabs")).toMatchObject({
      family: "elevenlabs_scribe",
      baseUrl: "https://api.elevenlabs.io/v1",
    });
    expect(aiConnectionFamilies("byo-ai").map((family) => family.id)).toContain(
      "elevenlabs_scribe",
    );
    expect(
      validateAiConnection({ ...draft, providerId, apiKey: "" }, false).apiKey,
    ).toBe("");
    expect(() =>
      validateAiConnection({ ...draft, providerId, apiKey: "" }),
    ).toThrow();
  },
);
it.each([
  ["providerId", "openai"],
  ["family", "openai_chat"],
  ["model", "owner/model"],
  ["authentication", "none"],
  ["apiKey", "private\r\nheader"],
  ["baseUrl", "https://user:password@unowned.example/v1"],
  ["baseUrl", "https://unowned.example/v1?key=secret"],
])("rejects incompatible speech configuration field %s", (field, value) => {
  expect(() => validateAiConnection({ ...draft, [field]: value })).toThrow();
});
it.each([
  { azure: { api: "v1", credential: "api-key" } },
  {
    vertex: {
      project: "project",
      location: "us-central1",
      credential: "service-account",
    },
  },
  { bedrock: { region: "us-east-1", credential: "sigv4" } },
])("does not borrow another protocol's credential format %#", (other) => {
  expect(() => validateAiConnection({ ...draft, ...other })).toThrow();
});
it("binds endpoint/model/family/auth to the existing credential reference", () => {
  const binding = aiConnectionBinding(draft);
  for (const change of [
    { baseUrl: "https://other.example/v1" },
    { model: "scribe_v1" },
    { family: "openai_chat" as const },
    { authentication: "none" as const },
  ])
    expect(aiConnectionBinding({ ...draft, ...change })).not.toBe(binding);
});
it("never sends audio through generic chat/header/answer/SSE or text provider parsing", async () => {
  const input = { model: draft.model, messages: [], media: ownedSpeechAudio() };
  expect(() => aiConnectionHeaders(draft)).toThrow("multipart");
  expect(() => aiInferenceRequest(draft, input)).toThrow("finite");
  expect(() => aiInferenceAnswer(draft.family, {})).toThrow("finite");
  expect(() => hostedModelRequest("openai", input)).toThrow();
  const response = new Response("data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
  await expect(
    readAiTextStream(
      response,
      draft.family,
      () => {},
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toThrow("finite");
  expect(response.body?.locked).toBe(false);
  await response.body?.cancel();
});
it.each([
  { model: "scribe_v1", messages: [], media: ownedSpeechAudio() },
  {
    model: "scribe_v2",
    messages: [{ role: "user" as const, content: "invent a prompt" }],
    media: ownedSpeechAudio(),
  },
  {
    model: "scribe_v2",
    messages: [],
    maxOutputTokens: 16,
    media: ownedSpeechAudio(),
  },
  { model: "scribe_v2", messages: [] },
])(
  "rejects mismatched or non-audio operation input before HTTP %#",
  async (input) => {
    await expect(
      inferAiConnection(
        draft,
        input,
        {
          signal: new AbortController().signal,
          assertCurrent() {},
          fetch: () => {
            throw new Error("Must not dispatch");
          },
        },
        () => {},
      ),
    ).rejects.toMatchObject({ code: "configuration" });
  },
);
