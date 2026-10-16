import { describe, expect, it } from "vitest";
import { validateAiConnection } from "./configuration.js";
import { aiConnectionDraft, aiConnectionPreset } from "./presets.js";

const draft = () => ({
  ...aiConnectionDraft("byo-ai"),
  baseUrl: "https://models.example/mount/v1",
  model: "model-v1",
  apiKey: "secret-key",
});
describe("common AI configuration", () => {
  it.each([
    "https://secret:password@models.example/v1",
    "https://models.example/v1?key=secret",
    "https://models.example/v1#secret",
    "http://models.example/v1",
    "https://models.example/%2e%2e/other",
    "https://models.example/v1\\other",
  ])("refuses unsafe endpoint %s", (baseUrl) => {
    expect(() => validateAiConnection({ ...draft(), baseUrl })).toThrow();
  });
  it("derives partner families and endpoints from the existing catalog", () => {
    expect(aiConnectionPreset("anthropic")).toMatchObject({
      family: "anthropic_messages",
      baseUrl: "https://api.anthropic.com/v1",
    });
    expect(aiConnectionPreset("gemini")).toMatchObject({
      family: "gemini_generate_content",
    });
    expect(aiConnectionPreset("groq")).toMatchObject({
      family: "openai_chat",
      baseUrl: "https://api.groq.com/openai/v1",
    });
    expect(aiConnectionPreset("replicate")).toBeNull();
    expect(() =>
      validateAiConnection({
        ...draft(),
        providerId: "anthropic",
        family: "openai_chat",
      }),
    ).toThrow(/protocol supported/);
  });
  it("does not let a Gemini model become a route or public fields disclose the API key", () => {
    expect(() =>
      validateAiConnection({
        ...draft(),
        family: "gemini_generate_content",
        model: "../other",
      }),
    ).toThrow();
    expect(() =>
      validateAiConnection({ ...draft(), name: "secret-key" }),
    ).toThrow(/public connection/);
  });
});
