/**
 * The connections a person sees in Add a connection, and the tags that
 * replace the old category subheaders. The allowlist is deliberately small:
 * a provider's catalog row still exists for a saved connection and for
 * Settings › Integrations, but the browse page only offers the curated set.
 */
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { isConnectionCatalogProvider } from "@opensesame/app-core/lib/connector-guidance.js";
import { INTEGRATION_AI_LABS } from "@opensesame/app-core/lib/integration-ai-labs.js";
import {
  MANAGED_CONNECTOR_IDS,
  isManagedConnector,
} from "@opensesame/app-core/lib/managed-connectors.js";
import { CATEGORY_LABELS } from "@opensesame/app-core/sections/connections/shared.js";
import {
  API_FAMILIES,
  apiFamilyFor,
  isFamilyCanonical,
} from "./catalog-families.js";

// Every managed connector stays except Linq, which the operator retired from
// this browse list. The source set is the managed-connector registry itself.
const MANAGED = new Set(
  [...MANAGED_CONNECTOR_IDS].filter((id) => id !== "linq"),
);

/**
 * Providers deliberately retired from the browse page. Their catalog rows
 * remain for existing saved connections and Settings › Integrations, but a
 * new connection no longer offers them.
 */
const RETIRED_FROM_BROWSE = new Set([
  "assemblyai",
  "byo-ai",
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
]);

/** Developer tools that OpenSesame itself uses for an integration. */
const FORGE = new Set(["github", "gitlab", "bitbucket", "codeberg", "origin"]);
const DEV_INTEGRATION = new Set([...FORGE, "vercel"]);

const PRODUCTIVITY = new Set([
  "asana",
  "calendly",
  "canva",
  "clickup",
  "docusign",
  "figma",
  "google",
  "google-drive",
  "m365",
  "obsidian",
  "linear",
  "make",
  "microsoft-teams",
  "monday",
  "n8n",
  "miro",
  "notion",
  "spotify",
  "zapier",
]);

const COMMUNICATION = new Set([
  "discord",
  "granola",
  "intuit-mailchimp",
  "linkedin",
  "photon",
  "reddit",
  "resend",
  "sendgrid",
  "slack",
  "twilio",
  "x",
  "zoom",
]);

const STORAGE = new Set([
  "box",
  "clickhouse",
  "convex",
  "dropbox",
  "neon",
  "pinecone",
  "planetscale",
  "snowflake",
]);

const CRM = new Set([
  "attio",
  "clay",
  "hubspot",
  "lemma",
  "paypal",
  "polar",
  "salesforce",
  "shopify",
  "stripe",
  "zomato",
]);

const AI = new Set<string>([
  ...INTEGRATION_AI_LABS.map((lab) => lab.id),
  "fal-ai",
  "higgsfield",
]);
const FAMILY = new Set(API_FAMILIES.map((family) => family.id));
const ALLOWED = new Set([
  ...FAMILY,
  ...MANAGED,
  ...DEV_INTEGRATION,
  ...PRODUCTIVITY,
  ...COMMUNICATION,
  ...STORAGE,
  ...CRM,
  ...AI,
]);

/**
 * Tiles that have no bundled Host catalog row yet. They are browse entries
 * backed by the provider's own auth details; a Host that later supplies the
 * same id wins and this copy is not added twice.
 */
function featuredProviders(
  providers: readonly Provider[],
): readonly Provider[] {
  const present = new Set(providers.map((provider) => provider.id));
  const base = providers[0];
  if (!base) return [];
  const clone = (
    source: Provider | undefined,
    id: string,
    displayName: string,
    category: Provider["category"],
  ): Provider => ({
    ...(source ?? base),
    id,
    displayName,
    category,
    configured: false,
    autoConfigurable: false,
    missingConfig: [],
    callbackUrl: null,
  });
  const google = providers.find((provider) => provider.id === "google");
  const microsoft = providers.find((provider) => provider.id === "microsoft");
  const rows: Provider[] = [
    clone(google, "google-drive", "Google Drive", "storage"),
    clone(microsoft, "m365", "M365", "productivity"),
    {
      ...clone(base, "obsidian", "Obsidian", "storage"),
      authKind: "api_key",
      docsUrl: "https://help.obsidian.md/",
      egress: {
        scheme: "https",
        authorities: ["127.0.0.1:27124"],
        pathPrefixes: [],
      },
      operations: [],
      scopes: [],
    },
    {
      ...clone(base, "polar", "Polar", "crm"),
      authKind: "api_key",
      docsUrl: "https://docs.polar.sh/",
      egress: {
        scheme: "https",
        authorities: ["api.polar.sh"],
        pathPrefixes: [],
      },
      operations: [],
      scopes: [],
    },
    {
      ...clone(base, "higgsfield", "Higgsfield", "ai_model_provider"),
      authKind: "api_key",
      docsUrl: "https://docs.higgsfield.ai/",
      egress: {
        scheme: "https",
        authorities: ["api.higgsfield.ai"],
        pathPrefixes: [],
      },
      operations: [],
      scopes: [],
    },
    {
      ...clone(base, "fal-ai", "FAL.ai", "ai_model_provider"),
      authKind: "api_key",
      docsUrl: "https://docs.fal.ai/",
      egress: {
        scheme: "https",
        authorities: ["fal.run", "queue.fal.run"],
        pathPrefixes: [],
      },
      operations: [],
      scopes: [],
    },
  ];
  const categories: Record<string, Provider["category"]> = {
    microsoft: "productivity",
    vercel: "developer",
    cloudflare: "developer",
    google: "productivity",
    azure: "encryption",
    aws: "cloud_secret_storage",
    gcp: "cloud_secret_storage",
  };
  for (const family of API_FAMILIES) {
    if (!present.has(family.id))
      rows.push(
        clone(base, family.id, family.name, categories[family.id] ?? "custom"),
      );
  }
  return rows.filter((provider) => !present.has(provider.id));
}

/** The curated providers, in one alphabetical browse list. */
export function curatedCatalogProviders(
  providers: readonly Provider[],
  options: { includeFeatured?: boolean; includeFamilies?: boolean } = {},
): Provider[] {
  const source = options.includeFeatured
    ? [...providers, ...featuredProviders(providers)]
    : providers;
  return source
    .filter(
      (provider) =>
        isConnectionCatalogProvider(provider) ||
        (options.includeFamilies === true && isFamilyCanonical(provider.id)),
    )
    .filter(
      (provider) =>
        provider.category !== "ai_model_provider" || AI.has(provider.id),
    )
    .filter(
      (provider) =>
        ALLOWED.has(provider.id) &&
        !RETIRED_FROM_BROWSE.has(provider.id) &&
        (!options.includeFamilies ||
          isFamilyCanonical(provider.id) ||
          apiFamilyFor(provider.id) === undefined),
    )
    .map((provider) => {
      const family = options.includeFamilies
        ? apiFamilyFor(provider.id)
        : undefined;
      return family && family.id === provider.id
        ? { ...provider, displayName: family.name }
        : provider;
    })
    .sort((left, right) =>
      left.displayName.localeCompare(right.displayName, "en", {
        sensitivity: "base",
      }),
    );
}

/** Tags shown on the tile; they replace the former category headings. */
export function catalogTags(provider: Provider): readonly string[] {
  const tags = new Set<string>();
  if (isManagedConnector(provider.id)) tags.add("Managed");
  if (provider.category === "ai_model_provider") {
    tags.add("AI");
  } else if (DEV_INTEGRATION.has(provider.id)) {
    tags.add("Developer tools");
    if (FORGE.has(provider.id)) tags.add("Backup/recovery");
  } else {
    tags.add(CATEGORY_LABELS[provider.category]);
  }
  if (MANAGED.has(provider.id)) {
    // A managed connector keeps its own category beside the managed tag.
    tags.add(CATEGORY_LABELS[provider.category]);
  }
  return [...tags];
}

export function catalogSearchText(provider: Provider): string {
  return [
    provider.displayName,
    provider.id,
    CATEGORY_LABELS[provider.category],
    ...catalogTags(provider),
    provider.category === "ai_model_provider" ? "model provider" : "",
  ]
    .join(" ")
    .toLocaleLowerCase();
}

export function matchesCatalog(provider: Provider, query: string): boolean {
  return !query || catalogSearchText(provider).includes(query);
}
