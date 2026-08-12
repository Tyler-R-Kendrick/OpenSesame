import { describe, expect, it } from "vitest";
import { bundledProviders } from "./embedded-catalog.js";

describe("embedded connector catalog", () => {
  it("contains every Fnox, LLM, and identity provider once", () => {
    const ids = bundledProviders.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(37);
    for (const id of [
      "azure-key-vault-secrets",
      "bitwarden",
      "anthropic",
      "openai",
      "azure-openai",
      "aws-bedrock",
      "openrouter",
      "huggingface",
      "better-auth",
      "workos",
      "auth0",
    ]) {
      expect(ids).toContain(id);
    }
  });
});
