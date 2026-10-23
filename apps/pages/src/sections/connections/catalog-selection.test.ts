import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { INTEGRATION_AI_LABS } from "@opensesame/app-core/lib/integration-ai-labs.js";
import { mergeVercelCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { describe, expect, it } from "vitest";
import {
  catalogTags,
  curatedCatalogProviders,
  matchesCatalog,
} from "./catalog-selection.js";

const providers = curatedCatalogProviders(
  mergeVercelCatalog(getBundledProviders()),
);
const byId = new Map(providers.map((provider) => [provider.id, provider]));

describe("the curated Connections list", () => {
  it("keeps the requested managed, productivity, communication, storage and CRM providers", () => {
    const ids = new Set(providers.map((provider) => provider.id));
    for (const id of [
      "linear",
      "microsoft",
      "microsoft-teams",
      "salesforce",
      "slack",
      "snowflake",
      "asana",
      "calendly",
      "canva",
      "clickup",
      "docusign",
      "figma",
      "google",
      "make",
      "monday",
      "n8n",
      "miro",
      "notion",
      "spotify",
      "zapier",
      "granola",
      "linkedin",
      "intuit-mailchimp",
      "photon",
      "reddit",
      "resend",
      "sendgrid",
      "twilio",
      "x",
      "zoom",
      "discord",
      "box",
      "clickhouse",
      "convex",
      "dropbox",
      "neon",
      "pinecone",
      "planetscale",
      "attio",
      "clay",
      "hubspot",
      "lemma",
      "paypal",
      "shopify",
      "stripe",
      "zomato",
      "github",
      "gitlab",
      "bitbucket",
      "codeberg",
      "origin",
      "vercel",
    ])
      expect(ids, id).toContain(id);
    expect(ids).not.toContain("linq");
    expect(ids).not.toContain("whoop");
    expect(ids).not.toContain("password-store");
    expect(ids).not.toContain("github-app");
  });

  it("keeps exactly the AI labs Settings › Integrations lists", () => {
    const allowed = new Set<string>(INTEGRATION_AI_LABS.map((lab) => lab.id));
    const ai = providers.filter(
      (provider) => provider.category === "ai_model_provider",
    );
    expect(ai.length).toBeGreaterThan(0);
    expect(ai.every((provider) => allowed.has(provider.id))).toBe(true);
    expect(ai.map((provider) => provider.id)).not.toContain("baseten");
    expect(ai.map((provider) => provider.id)).toEqual(
      expect.arrayContaining(["openai", "anthropic", "byo-ai"]),
    );
  });

  it("puts BYO before partners while preserving alphabetical partner order and the input", () => {
    const input = ["vercel", "openai", "byo-ai", "asana", "anthropic"].map(
      (id) => {
        const provider = byId.get(id);
        if (!provider) throw new Error(`Missing curated provider: ${id}`);
        return provider;
      },
    );
    const original = [...input];
    const ordered = curatedCatalogProviders(input);
    expect(ordered.map((provider) => provider.id)).toEqual([
      "byo-ai",
      "anthropic",
      "asana",
      "openai",
      "vercel",
    ]);
    expect(input).toEqual(original);
    expect(
      ordered
        .filter((provider) => matchesCatalog(provider, "model provider"))
        .map((provider) => provider.id),
    ).toEqual(["byo-ai", "anthropic", "openai"]);
  });

  it("never admits an AI provider outside the Settings list", () => {
    const fake = {
      ...providers[0],
      id: "outside-ai",
      displayName: "Outside AI",
      category: "ai_model_provider" as const,
      autoConfigurable: false,
    };
    expect(curatedCatalogProviders([fake])).toEqual([]);
  });

  it("tags former headers and searches them", () => {
    const linear = byId.get("linear");
    const openai = byId.get("openai");
    const github = byId.get("github");
    const stripe = byId.get("stripe");
    if (!linear || !openai || !github || !stripe)
      throw new Error("Expected curated providers");
    expect(catalogTags(linear)).toEqual(
      expect.arrayContaining(["Managed", "Productivity"]),
    );
    expect(catalogTags(openai)).toContain("AI");
    expect(catalogTags(github)).toEqual(
      expect.arrayContaining(["Developer tools", "Backup/recovery"]),
    );
    expect(catalogTags(stripe)).toContain("CRM");
    expect(matchesCatalog(linear, "managed")).toBe(true);
    expect(matchesCatalog(openai, "model provider")).toBe(true);
    expect(matchesCatalog(github, "backup")).toBe(true);
    expect(matchesCatalog(stripe, "crm")).toBe(true);
  });
});
