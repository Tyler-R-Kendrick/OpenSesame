import { afterEach, describe, expect, it, vi } from "vitest";
import {
  modelMemoryBackend,
  saveModelFixture,
} from "./hosted-model.test-support.js";
import {
  choiceFromSlug,
  choiceToSlug,
  connectedHarnessProviderIds,
  encodeModelSlug,
  inferenceSlugOptions,
  modelSlugSeams,
  voiceSlugOptions,
} from "./model-slugs.js";

afterEach(() => vi.restoreAllMocks());
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

  it("offers verified native Gemini models even when the legacy directory is unavailable", async () => {
    modelMemoryBackend();
    await saveModelFixture("gemini");
    await saveModelFixture("openai", false);
    vi.spyOn(modelSlugSeams, "listConnections").mockRejectedValue(
      new Error("Offline"),
    );
    const ids = await connectedHarnessProviderIds();
    expect(ids).toEqual(["gemini"]);
    const options = inferenceSlugOptions({
      browserReady: false,
      connectedProviderIds: ids,
    });
    expect(
      options.some((option) => option.value === "gemini/gemini-2.5-flash"),
    ).toBe(true);
    expect(options.some((option) => option.choice.provider === "openai")).toBe(
      false,
    );
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
