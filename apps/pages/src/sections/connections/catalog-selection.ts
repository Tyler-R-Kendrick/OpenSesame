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
  "salesforce",
  "shopify",
  "stripe",
  "zomato",
]);

const AI = new Set<string>(INTEGRATION_AI_LABS.map((lab) => lab.id));
const ALLOWED = new Set([
  ...MANAGED,
  ...DEV_INTEGRATION,
  ...PRODUCTIVITY,
  ...COMMUNICATION,
  ...STORAGE,
  ...CRM,
  ...AI,
]);

/** The curated providers, in one alphabetical browse list. */
export function curatedCatalogProviders(
  providers: readonly Provider[],
): Provider[] {
  return providers
    .filter((provider) => isConnectionCatalogProvider(provider))
    .filter(
      (provider) =>
        provider.category !== "ai_model_provider" || AI.has(provider.id),
    )
    .filter(
      (provider) =>
        ALLOWED.has(provider.id) && !RETIRED_FROM_BROWSE.has(provider.id),
    )
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
