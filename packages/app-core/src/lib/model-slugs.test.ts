import { describe, expect, it } from "vitest";
import {
  choiceFromSlug,
  choiceToSlug,
  encodeModelSlug,
  inferenceSlugOptions,
  voiceSlugOptions,
} from "./model-slugs.js";

describe("model-slugs", () => {
  it("encodes provider/model", () => {
    expect(encodeModelSlug("openai", "gpt-4o")).toBe("openai/gpt-4o");
    expect(encodeModelSlug("browser", "")).toBe("browser/");
  });

  it("lists voice languages when speech is ready", () => {
    const options = voiceSlugOptions(true);
    expect(options.some((row) => row.value === "browser-speech/en-US")).toBe(
      true,
    );
    expect(voiceSlugOptions(false)).toEqual([]);
  });

  it("keeps local inference without a harness, and hosted only when connected", () => {
    const bare = inferenceSlugOptions({
      browserReady: false,
      connectedProviderIds: [],
    });
    expect(bare.some((row) => row.value === "ollama/llama3.2")).toBe(true);
    expect(bare.some((row) => row.choice.provider === "openai")).toBe(false);

    const withOpenAi = inferenceSlugOptions({
      browserReady: true,
      connectedProviderIds: ["openai"],
    });
    expect(withOpenAi.some((row) => row.value === "browser/")).toBe(true);
    expect(withOpenAi.some((row) => row.value === "openai/gpt-4o")).toBe(true);
  });

  it("round-trips a choice through a slug option list", () => {
    const options = inferenceSlugOptions({
      browserReady: false,
      connectedProviderIds: ["anthropic"],
    });
    const choice = choiceFromSlug("anthropic/claude-sonnet-4-5", options);
    expect(choice).not.toBeNull();
    if (choice === null) return;
    expect(choice.provider).toBe("anthropic");
    expect(choiceToSlug(choice)).toBe("anthropic/claude-sonnet-4-5");
  });
});
