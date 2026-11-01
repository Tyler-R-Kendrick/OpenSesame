import { describe, expect, it } from "vitest";
import { AI_MODEL_PROVIDER_IDS } from "./ai-model-provider-ids.generated.js";
import { getBundledProviders } from "./embedded-catalog.js";

describe("password reset integration suggestions", () => {
  it("shares runtime and model provider suggestions through the generated catalog", () => {
    const providers = getBundledProviders();
    for (const id of ["vercel-sandbox", "e2b", "browserbase-cdp"]) {
      expect(providers.find((provider) => provider.id === id)).toMatchObject({
        category: "cua_runtime",
        authKind: "configuration",
      });
    }
    expect(AI_MODEL_PROVIDER_IDS).toEqual(
      expect.arrayContaining(["openai", "anthropic", "vercel-ai-gateway"]),
    );
  });

  it("enables the anonymous Cloudflare and Vercel relays by default", () => {
    const providers = getBundledProviders();
    for (const id of ["cloudflare-anonymous", "vercel-anonymous"]) {
      expect(providers.find((provider) => provider.id === id)).toMatchObject({
        category: "cua_runtime",
        configured: true,
        autoConfigurable: true,
      });
    }
  });

  it("lists Boat as an optional runtime that is off until configured", () => {
    const boat = getBundledProviders().find(
      (provider) => provider.id === "boat",
    );
    expect(boat).toMatchObject({
      category: "cua_runtime",
      configured: false,
      autoConfigurable: false,
    });
  });
});
