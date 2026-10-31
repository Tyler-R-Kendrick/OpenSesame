/**
 * The AI model provider category (ADR 0192): one catalog row each, spoken to
 * through a closed protocol, and the browser's connect plan for a row never
 * disagrees with the row it came from.
 */
import { describe, expect, it } from "vitest";
import { renderAiProviderIds } from "../../scripts/emit-connector-catalog.mjs";
import { AI_MODEL_PROVIDER_IDS } from "./ai-model-provider-ids.generated.js";
import { connectPlan } from "./connect-plan.js";
import { catalogProviders } from "./connector-catalog.js";
import { LLM_PROVIDER_IDS } from "./embedded-catalog-data.js";
import { getBundledProviders } from "./embedded-catalog.js";

const rows = () =>
  catalogProviders().filter((row) => row.category === "ai_model_provider");

describe("AI model providers in the catalog", () => {
  it("lists a catalog of their own, every row bundled and none twice", () => {
    const ids = rows().map((row) => row.id);
    expect(ids.length).toBeGreaterThanOrEqual(80);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...AI_MODEL_PROVIDER_IDS]).toEqual(ids);
    expect(LLM_PROVIDER_IDS).toBe(AI_MODEL_PROVIDER_IDS);
    const bundled = new Set(getBundledProviders().map((row) => row.id));
    expect(ids.filter((id) => !bundled.has(id))).toEqual([]);
  });

  it("keeps the generated id module in step with the catalog view", () => {
    const rendered = renderAiProviderIds();
    for (const id of rows().map((row) => row.id)) {
      expect(rendered).toContain(`  ${JSON.stringify(id)},`);
    }
    expect(rendered.match(/^ {2}"/gm)).toHaveLength(rows().length);
  });

  it("moves every provider that used to be a harness into the new category", () => {
    for (const id of [
      "openai",
      "anthropic",
      "cohere",
      "mistral",
      "groq",
      "perplexity",
      "together",
      "replicate",
      "huggingface",
      "gemini",
      "fireworks",
      "azure-openai",
      "aws-bedrock",
      "openrouter",
    ]) {
      expect(AI_MODEL_PROVIDER_IDS, id).toContain(id);
    }
    expect(
      catalogProviders().filter((row) => row.category === "agent_harnesses"),
    ).toEqual([]);
  });

  it("names how each row is spoken to, and only these rows do", () => {
    for (const row of catalogProviders()) {
      if (row.category !== "ai_model_provider") {
        expect(row.modelApi, row.id).toBeUndefined();
        continue;
      }
      expect(row.modelApi, row.id).toBeDefined();
      const api = row.modelApi;
      if (!api) continue;
      if (row.authKind === "configuration") {
        // the endpoint is the person's own, so the row cannot pin one
        expect(api.baseUrl, row.id).toBeUndefined();
        expect(row.egress.authorities, row.id).toEqual([]);
        continue;
      }
      const base = new URL(api.baseUrl ?? "");
      expect(base.protocol, row.id).toBe("https:");
      expect(api.baseUrl?.endsWith("/"), row.id).toBe(false);
      expect(row.egress.authorities, row.id).toContain(base.host);
      if (row.egress.pathPrefixes.length > 0) {
        expect(
          row.egress.pathPrefixes.some((prefix) =>
            `${base.pathname}/`.startsWith(prefix),
          ),
          row.id,
        ).toBe(true);
      }
    }
  });

  it("never carries a credential, a header or a path in the row's model block", () => {
    for (const row of rows()) {
      expect(Object.keys(row.modelApi ?? {}).sort(), row.id).toEqual(
        row.authKind === "configuration"
          ? ["protocol"]
          : ["baseUrl", "protocol"],
      );
    }
  });
});

describe("the browser's connect plan for a model row", () => {
  it("sends the key to the row's own host, in the row's own header", () => {
    let planned = 0;
    for (const row of rows()) {
      const method = connectPlan(row.id)?.methods.find(
        (entry) => entry.kind === "api-key",
      );
      if (method?.kind !== "api-key" || !method.preset) continue;
      planned += 1;
      const hosts = new Set(row.egress.authorities);
      // A researched preset may also name a second host (Hugging Face's hub
      // verifies a token); the row's own host is always one of them.
      expect(
        method.urls.some((url) => hosts.has(new URL(url).host)),
        row.id,
      ).toBe(true);
      const verify = method.preset.verify;
      // A key is proved by a read. Where a provider offers none a page can use,
      // the check is its own free key route (NEAR AI's key check, Higgsfield's
      // model listing, which takes a POST), or one token of chat that the
      // instructions say the provider may bill.
      if (verify?.method === "POST")
        expect(
          verify.url.endsWith("/check_api_key") ||
            verify.url === "https://api.higgsfield.ai/v1/models" ||
            (verify.url.endsWith("/chat/completions") &&
              method.preset.instructions.includes("may bill")),
          row.id,
        ).toBe(true);
      else expect(verify?.method, row.id).toBe("GET");
      expect(method.preset.auth?.kind, row.id).toBe("header");
    }
    expect(planned).toBeGreaterThanOrEqual(25);
  });
});
