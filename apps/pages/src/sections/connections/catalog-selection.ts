/** Curated Add a connection rows and searchable tags.
 * Other catalog rows remain available to saved connections and Settings.
 */
import { byoProvidersFirst } from "@opensesame/app-core/lib/catalog-provider.js";
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
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

type CatalogFamilyCategories = {
  readonly microsoft: Provider["category"];
  readonly vercel: Provider["category"];
  readonly cloudflare: Provider["category"];
  readonly google: Provider["category"];
  readonly azure: Provider["category"];
  readonly aws: Provider["category"];
  readonly gcp: Provider["category"];
};

// The registry owns managed rows; Linq is retired from browse.
const MANAGED = new Set(
  [...MANAGED_CONNECTOR_IDS].filter((id) => id !== "linq"),
);

/** Retired from browse; saved connections and Settings retain these rows. */
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

/** Featured browse rows; an actual provider with the same ID takes precedence. */
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
  const categories: CatalogFamilyCategories = {
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
        clone(
          base,
          family.id,
          family.name,
          Object.entries(categories).find(([id]) => id === family.id)?.[1] ??
            "custom",
        ),
      );
  }
  return rows.filter((provider) => !present.has(provider.id));
}

export type CatalogSelectionOptions = {
  includeFeatured?: boolean;
  includeFamilies?: boolean;
};

/** Curated browse providers stay alphabetical. */
export function curatedCatalogProviders(
  providers: readonly Provider[],
  options: CatalogSelectionOptions = {},
): Provider[] {
  const source = options.includeFeatured
    ? [...providers, ...featuredProviders(providers)]
    : providers;
  return byoProvidersFirst(
    source
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
      ),
  );
}

/** The auth/integration methods a tile supports, as user-facing pills. */
export function catalogAuthMethods(provider: Provider): readonly string[] {
  const methods = new Set<string>();
  for (const method of connectPlan(provider.id)?.methods ?? []) {
    if (method.kind === "oauth") methods.add("OAuth");
    else if (method.kind === "api-key") methods.add("API key");
    else if (method.kind === "mcp") methods.add("MCP");
  }
  if (provider.authKind === "oauth2_authorization_code") methods.add("OAuth");
  if (provider.authKind === "api_key") methods.add("API key");
  if (provider.authKind === "configuration") methods.add("Configuration");
  if (isManagedConnector(provider.id)) methods.add("Managed");
  return [
    "OAuth",
    "API key",
    "MCP",
    "OIDC",
    "Local",
    "Configuration",
    "Managed",
  ].filter((method) => methods.has(method));
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
