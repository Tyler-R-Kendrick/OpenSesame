import { describe, expect, it } from "vitest";
import { bundledProviders } from "./embedded-catalog.js";

describe("embedded connector catalog", () => {
  it("contains every Fnox provider and the requested LLM providers once", () => {
    const ids = bundledProviders.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(34);
    for (const id of [
      "azure-key-vault-secrets",
      "bitwarden",
      "anthropic",
      "openai",
      "azure-openai",
      "aws-bedrock",
      "openrouter",
      "huggingface",
    ]) {
      expect(ids).toContain(id);
    }
  });
});
