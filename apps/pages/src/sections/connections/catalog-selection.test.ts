import { canonicalProviderId } from "@opensesame/app-core/lib/connector-catalog.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { INTEGRATION_AI_LABS } from "@opensesame/app-core/lib/integration-ai-labs.js";
import { mergeVercelCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { connectionRouteProvider } from "@opensesame/app-core/sections/connections/provider-route.js";
import { describe, expect, it } from "vitest";
import { API_FAMILIES, apiFamilyFor } from "./catalog-families.js";
import {
  catalogAuthMethods,
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
    for (const retired of [
      "assemblyai",
      "cohere",
      "deepgram",
      "minimax",
      "mistral",
      "moonshotai",
      "photon",
      "replicate",
      "stability",
      "together",
      "xiaomi",
      "zai",
    ])
      expect(ids, retired).not.toContain(retired);
    expect(ids).not.toContain("linq");
    expect(ids).not.toContain("whoop");
    expect(ids).not.toContain("password-store");
    expect(ids).not.toContain("github-app");
  });

  it("shows one family tile and hides its member APIs", () => {
    const grouped = curatedCatalogProviders(
      mergeVercelCatalog(getBundledProviders()),
      { includeFeatured: true, includeFamilies: true },
    );
    const ids = grouped.map((provider) => provider.id);
    for (const id of [
      "microsoft",
      "vercel",
      "cloudflare",
      "google",
      "azure-sm",
      "aws",
      "gcp",
    ])
      expect(ids, id).toContain(id);
    for (const id of [
      "m365",
      "microsoft-teams",
      "vercel-ai-gateway",
      "cloudflare-workers-ai",
      "google-drive",
      "azure-kms",
      "aws-kms",
      "gcp-kms",
    ])
      expect(ids, id).not.toContain(id);
    expect(
      grouped.find((provider) => provider.id === "azure-sm")?.category,
    ).toBe("cloud_secret_storage");
    const withoutAzure = curatedCatalogProviders(
      mergeVercelCatalog(getBundledProviders()).filter(
        (provider) => canonicalProviderId(provider.id) !== "azure-sm",
      ),
      { includeFeatured: true, includeFamilies: true },
    );
    expect(
      withoutAzure.find((provider) => provider.id === "azure-sm")?.category,
    ).toBe("encryption");
    expect(grouped.find((provider) => provider.id === "aws")?.displayName).toBe(
      "AWS",
    );
    expect(
      grouped.find((provider) => provider.id === "azure-sm")?.displayName,
    ).toBe("Azure");
  });

  it("offers the featured additions in Add a connection", () => {
    const featured = curatedCatalogProviders(
      mergeVercelCatalog(getBundledProviders()),
      { includeFeatured: true },
    ).map((provider) => provider.id);
    for (const id of [
      "obsidian",
      "google-drive",
      "m365",
      "polar",
      "higgsfield",
      "fal-ai",
    ])
      expect(featured, id).toContain(id);
  });

  it("keeps only the non-retired AI labs from Settings › Integrations", () => {
    const allowed = new Set<string>(INTEGRATION_AI_LABS.map((lab) => lab.id));
    const ai = providers.filter(
      (provider) => provider.category === "ai_model_provider",
    );
    expect(ai.length).toBeGreaterThan(0);
    expect(ai.every((provider) => allowed.has(provider.id))).toBe(true);
    expect(ai.map((provider) => provider.id)).not.toContain("baseten");
    expect(ai.map((provider) => provider.id)).toEqual(
      expect.arrayContaining(["openai", "anthropic"]),
    );
  });

  it("retires BYO AI from browse while partners stay alphabetical and the input is preserved", () => {
    const allById = new Map(
      mergeVercelCatalog(getBundledProviders()).map((provider) => [
        provider.id,
        provider,
      ]),
    );
    const input = ["vercel", "openai", "byo-ai", "asana", "anthropic"].map(
      (id) => {
        const provider = allById.get(id);
        if (!provider) throw new Error(`Missing bundled provider: ${id}`);
        return provider;
      },
    );
    const original = [...input];
    const ordered = curatedCatalogProviders(input);
    expect(ordered.map((provider) => provider.id)).toEqual([
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
    ).toEqual(["anthropic", "openai"]);
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

  it("keeps canonical family aliases as one catalog row with its category", () => {
    const catalog = mergeVercelCatalog(getBundledProviders());
    const grouped = curatedCatalogProviders(catalog, {
      includeFeatured: true,
      includeFamilies: true,
    });
    for (const family of API_FAMILIES) {
      const original = catalog.find(
        (provider) => canonicalProviderId(provider.id) === family.id,
      );
      if (!original) continue;
      const tiles = grouped.filter((provider) => provider.id === family.id);
      expect(tiles, family.id).toHaveLength(1);
      expect(tiles[0]?.category, family.id).toBe(original.category);
      expect(tiles[0]?.egress, family.id).toEqual(original.egress);
    }
  });

  it("keeps every provider family complete", () => {
    for (const family of API_FAMILIES) {
      expect(apiFamilyFor(family.id)?.id, family.id).toBe(family.id);
      expect(family.members.length, family.id).toBeGreaterThan(1);
    }
  });

  it("keeps Azure and cloud aliases on their canonical routes", () => {
    const catalog = mergeVercelCatalog(getBundledProviders());
    const azure = apiFamilyFor("azure-sm");
    expect(azure?.members).toEqual([
      "azure-sm",
      "azure-kms",
      "azure-ac",
      "azure-openai",
      "azure-access-token",
    ]);
    for (const member of azure?.members ?? []) {
      const routed = connectionRouteProvider(catalog, member);
      expect(canonicalProviderId(routed?.id ?? ""), member).toBe(member);
      expect(apiFamilyFor(routed?.id ?? "")?.id, member).toBe(azure?.id);
    }
    expect(apiFamilyFor("azure-kms")?.members).toContain("azure-kms");
    expect(apiFamilyFor("aws-secrets-manager")?.id).toBe("aws");
    expect(apiFamilyFor("gcp-secret-manager")?.id).toBe("gcp");
    expect(apiFamilyFor("azure-key-vault-secrets")?.id).toBe("azure-sm");
  });

  it("labels each card with supported auth methods, not internal tags", () => {
    const openai = byId.get("openai");
    const github = byId.get("github");
    if (!openai || !github) throw new Error("Expected curated providers");
    expect(catalogAuthMethods(openai)).toContain("API key");
    expect(catalogAuthMethods(github).length).toBeGreaterThan(0);
    expect(catalogAuthMethods(openai)).not.toContain("Managed");
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
