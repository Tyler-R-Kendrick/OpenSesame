/**
 * Vercel Connect browse catalog (https://vercel.com/connect/browse).
 * Listed on Connections regardless of Host. A row is connectable unless
 * OpenSesame refuses it (payment processors / card issue).
 */

import type { AuthKind, Connection, Provider } from "./connections.js";

type Methods = "managed" | "oauth" | "api_key" | "mcp";

/** id, display name, connection methods from the Vercel browse catalog. */
const ROWS: [string, string, Methods][] = [
  ["github", "GitHub", "managed"],
  ["linear", "Linear", "managed"],
  ["linq", "Linq", "managed"],
  ["microsoft", "Microsoft", "managed"],
  ["microsoft-teams", "Microsoft Teams", "managed"],
  ["salesforce", "Salesforce", "managed"],
  ["slack", "Slack", "managed"],
  ["snowflake", "Snowflake", "managed"],
  ["vercel", "Vercel", "oauth"],
  ["agentcard", "Agentcard", "oauth"],
  ["agentmail", "AgentMail", "mcp"],
  ["airtable", "Airtable", "mcp"],
  ["anthropic", "Anthropic", "api_key"],
  ["api-key", "API Key", "api_key"],
  ["asana", "Asana", "mcp"],
  ["auth0", "Auth0", "oauth"],
  ["bamboohr", "BambooHR", "oauth"],
  ["beehiiv", "beehiiv", "oauth"],
  ["bitly", "Bitly", "mcp"],
  ["box", "Box", "mcp"],
  ["brex", "Brex", "mcp"],
  ["calendly", "Calendly", "oauth"],
  ["candid", "Candid", "mcp"],
  ["canva", "Canva", "oauth"],
  ["circleci", "CircleCI", "api_key"],
  ["clerk", "Clerk", "api_key"],
  ["clickhouse", "ClickHouse", "mcp"],
  ["clickup", "ClickUp", "oauth"],
  ["cloudflare", "Cloudflare", "mcp"],
  ["cloudinary", "Cloudinary", "mcp"],
  ["coda", "Coda", "mcp"],
  ["cohere", "Cohere", "api_key"],
  ["contentful", "Contentful", "api_key"],
  ["convex", "Convex", "oauth"],
  ["crowdin", "Crowdin", "oauth"],
  ["databricks", "Databricks", "oauth"],
  ["datadog", "Datadog", "api_key"],
  ["deepgram", "Deepgram", "api_key"],
  ["deepseek", "DeepSeek", "api_key"],
  ["docusign", "Docusign", "oauth"],
  ["dovetail", "Dovetail", "api_key"],
  ["dropbox", "Dropbox", "oauth"],
  ["egnyte", "Egnyte", "mcp"],
  ["elevenlabs", "ElevenLabs", "api_key"],
  ["embat", "Embat", "mcp"],
  ["fathom", "Fathom", "mcp"],
  ["figma", "Figma", "oauth"],
  ["firecrawl", "Firecrawl", "api_key"],
  ["g2", "G2", "mcp"],
  ["gitee", "Gitee", "oauth"],
  ["gitlab", "GitLab", "oauth"],
  ["google", "Google", "oauth"],
  ["gemini", "Google Gemini", "api_key"],
  ["harvest", "Harvest", "oauth"],
  ["hubspot", "HubSpot", "oauth"],
  ["hugging-face", "Hugging Face", "mcp"],
  ["intercom", "Intercom", "oauth"],
  ["jira", "Jira", "oauth"],
  ["kernel", "Kernel", "mcp"],
  ["linkedin", "LinkedIn", "oauth"],
  ["local-falcon", "Local Falcon", "mcp"],
  ["mailgun", "Mailgun", "api_key"],
  ["make", "Make", "mcp"],
  ["manufact", "Manufact", "mcp"],
  ["mem0", "Mem0", "mcp"],
  ["miro", "Miro", "mcp"],
  ["mixpanel", "Mixpanel", "mcp"],
  ["monday", "monday.com", "oauth"],
  ["n8n", "n8n", "api_key"],
  ["neon", "Neon", "api_key"],
  ["netlify", "Netlify", "mcp"],
  ["ngrok", "ngrok", "api_key"],
  ["notion", "Notion", "oauth"],
  ["npm", "npm", "api_key"],
  ["oreilly", "O’Reilly", "mcp"],
  ["oauth", "OAuth", "oauth"],
  ["okta", "Okta", "oauth"],
  ["openai", "OpenAI", "api_key"],
  ["openrouter", "OpenRouter", "api_key"],
  ["pagerduty", "PagerDuty", "mcp"],
  ["perplexity", "Perplexity", "api_key"],
  ["photon", "Photon", "api_key"],
  ["pinecone", "Pinecone", "api_key"],
  ["planetscale", "PlanetScale", "mcp"],
  ["posthog", "PostHog", "mcp"],
  ["postman", "Postman", "mcp"],
  ["railway", "Railway", "api_key"],
  ["razorpay", "Razorpay", "mcp"],
  ["reddit", "Reddit", "oauth"],
  ["render", "Render", "api_key"],
  ["replicate", "Replicate", "api_key"],
  ["resend", "Resend", "oauth"],
  ["sanity", "Sanity", "oauth"],
  ["segment", "Segment", "api_key"],
  ["sendgrid", "SendGrid", "api_key"],
  ["sentry", "Sentry", "mcp"],
  ["shopify", "Shopify", "oauth"],
  ["similarweb", "Similarweb", "mcp"],
  ["spotify", "Spotify", "oauth"],
  ["stripe", "Stripe", "mcp"],
  ["supabase", "Supabase", "mcp"],
  ["telegram", "Telegram Bot", "api_key"],
  ["ticket-tailor", "Ticket Tailor", "mcp"],
  ["ticktick", "TickTick", "mcp"],
  ["tinybird", "Tinybird", "api_key"],
  ["todoist", "Todoist", "mcp"],
  ["twitch", "Twitch", "oauth"],
  ["typeform", "Typeform", "oauth"],
  ["webflow", "Webflow", "oauth"],
  ["whoop", "WHOOP", "oauth"],
  ["wix", "Wix", "mcp"],
  ["workday", "Workday", "oauth"],
  ["workos", "WorkOS", "oauth"],
  ["x", "X", "oauth"],
  ["xero", "Xero", "mcp"],
  ["zapier", "Zapier", "mcp"],
  ["zeplin", "Zeplin", "oauth"],
  ["zernio", "Zernio", "mcp"],
  ["zomato", "Zomato", "mcp"],
  ["zoom", "Zoom", "oauth"],
];

const BLOCKED = new Set(["stripe", "razorpay", "agentcard"]);

const CATEGORY = {
  auth0: "identity",
  clerk: "identity",
  okta: "identity",
  workos: "identity",
  microsoft: "identity",
  github: "backup_recovery",
  gitlab: "backup_recovery",
  gitee: "backup_recovery",
  supabase: "backup_recovery",
  neon: "backup_recovery",
  planetscale: "backup_recovery",
  convex: "backup_recovery",
  anthropic: "agent_harnesses",
  openai: "agent_harnesses",
  gemini: "agent_harnesses",
  openrouter: "agent_harnesses",
  cohere: "agent_harnesses",
  deepseek: "agent_harnesses",
  perplexity: "agent_harnesses",
  "hugging-face": "agent_harnesses",
  replicate: "agent_harnesses",
  firecrawl: "agent_harnesses",
  slack: "communication",
  "microsoft-teams": "communication",
  telegram: "communication",
  linq: "communication",
  photon: "communication",
  intercom: "communication",
  linear: "productivity",
  notion: "productivity",
  asana: "productivity",
  clickup: "productivity",
  monday: "productivity",
  jira: "productivity",
  todoist: "productivity",
  ticktick: "productivity",
  miro: "productivity",
  coda: "productivity",
  salesforce: "crm",
  hubspot: "crm",
  snowflake: "storage",
  dropbox: "storage",
  box: "storage",
  clickhouse: "storage",
  databricks: "storage",
  pinecone: "storage",
  ngrok: "networking",
  oauth: "custom",
  "api-key": "custom",
} satisfies Record<string, Provider["category"]>;

const EMPTY_STRING_LIST: string[] = [];

const EMPTY_EGRESS = {
  scheme: "https",
  authorities: EMPTY_STRING_LIST,
  pathPrefixes: EMPTY_STRING_LIST,
};

function authKind(methods: Methods): AuthKind {
  if (methods === "api_key") return "api_key";
  if (methods === "mcp") return "configuration";
  return "oauth2_authorization_code";
}

function toProvider(row: [string, string, Methods]): Provider {
  const [id, displayName, methods] = row;
  return {
    id,
    displayName,
    category: Object.hasOwn(CATEGORY, id)
      ? // SAFETY: Object.hasOwn checked id is a CATEGORY key above.
        CATEGORY[id as keyof typeof CATEGORY]
      : "developer",
    docsUrl: `https://vercel.com/connect/${id}`,
    authKind: authKind(methods),
    supportsRefresh: methods === "managed" || methods === "oauth",
    configured: false,
    autoConfigurable: false,
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: EMPTY_EGRESS,
    operations: [],
  };
}

const CATALOG = ROWS.map(toProvider);
const CATALOG_IDS = new Set(CATALOG.map((row) => row.id));

export function isVercelCatalogId(id: string): boolean {
  return CATALOG_IDS.has(id);
}

export function isVercelConnectable(id: string): boolean {
  return isVercelCatalogId(id) && !BLOCKED.has(id);
}

export function vercelConnectCatalog(): Provider[] {
  return CATALOG.map((row) => ({ ...row }));
}

/** Vercel browse catalog, then OpenSesame-only bundled rows Vercel does not list. */
export function mergeVercelCatalog(bundled: readonly Provider[]): Provider[] {
  const extra = bundled.filter((row) => !CATALOG_IDS.has(row.id));
  return [...vercelConnectCatalog(), ...extra];
}

export const vercelCatalogSeams = {
  providers: (bundled: readonly Provider[]): Provider[] =>
    mergeVercelCatalog(bundled),
};

export type CatalogTileNote = { label: string; tone: string };

export function catalogTileNote(
  provider: Provider,
  connection: Connection | null,
): CatalogTileNote | null {
  if (BLOCKED.has(provider.id)) {
    return { label: "Not connectable", tone: "chip--err" };
  }
  const live =
    connection && connection.status !== "revoked" ? connection : null;
  if (live) {
    if (live.status === "active") {
      return { label: "Connected", tone: "chip--ok" };
    }
    if (live.status === "error") {
      return { label: "Broken", tone: "chip--err" };
    }
    return { label: "Needs you", tone: "chip--warn" };
  }
  if (isVercelCatalogId(provider.id)) {
    return { label: "Not configured", tone: "chip" };
  }
  return null;
}
