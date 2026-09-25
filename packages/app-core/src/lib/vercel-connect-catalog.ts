/**
 * The Connections catalog on Vercel Connect (ADR 0146): one row per connector
 * plan — every service in Vercel's registry, plus the catalog rows it does
 * not list — each configurable, because each plan carries a way in (Vercel's
 * app, a self-registering MCP server, an OAuth preset, an API key, or the
 * generic OAuth integration). Payment rails stay refused (ADR 0086 §6).
 */

import {
  type ConnectPlan,
  connectPlans,
  preferredMethod,
} from "./connect-plan.js";
import type { Connection, Provider } from "./connections.js";

/** Host-owned rows keep their own flow (GitHub's App, ADR 0126). */
const HOST_OWNED = new Set(["github"]);

const EMPTY_STRING_LIST: string[] = [];

function hostsOf(plan: ConnectPlan): string[] {
  const urls: string[] = [];
  for (const method of plan.methods) {
    if (method.kind === "oauth" && method.preset)
      urls.push(method.preset.serverUrl);
    if (method.kind === "mcp") urls.push(method.mcp.url);
    if (method.kind === "api-key") urls.push(...method.urls);
  }
  const hosts = new Set<string>();
  for (const raw of urls) {
    try {
      if (!raw.includes("{")) hosts.add(new URL(raw).host);
    } catch {
      // not a URL
    }
  }
  return [...hosts].slice(0, 6);
}

function toProvider(plan: ConnectPlan): Provider {
  const method = preferredMethod(plan);
  const oauth = plan.methods.find(
    (item) => item.kind === "oauth" && item.preset !== null,
  );
  const preset = oauth?.kind === "oauth" ? oauth.preset : null;
  return {
    id: plan.id,
    displayName: plan.name,
    category: plan.category,
    docsUrl:
      plan.docsUrl ?? plan.website ?? `https://vercel.com/connect/${plan.id}`,
    authKind:
      method?.kind === "api-key" ? "api_key" : "oauth2_authorization_code",
    supportsRefresh: preset?.refreshTokens ?? method?.kind !== "api-key",
    // Configurable: the page opens filled in. It still needs a person to
    // authorize; autoConfigurable is only for built-ins like WebCrypto.
    configured: !plan.refused,
    autoConfigurable: false,
    missingConfig: [],
    callbackUrl: null,
    scopes: (preset?.scopes ?? []).map((scope) => ({
      name: scope.name,
      description: scope.description,
      sensitive: false,
      default: scope.default,
    })),
    egress: {
      scheme: "https",
      authorities: hostsOf(plan),
      pathPrefixes: EMPTY_STRING_LIST,
    },
    operations: [],
  };
}

const PLANS = connectPlans().filter((plan) => !HOST_OWNED.has(plan.id));
const BLOCKED = new Set(PLANS.filter((plan) => plan.refused).map((p) => p.id));
const CATALOG = PLANS.map(toProvider);
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
