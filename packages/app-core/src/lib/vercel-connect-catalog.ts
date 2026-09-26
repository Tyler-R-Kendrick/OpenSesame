/**
 * The Connections catalog on Vercel Connect (ADR 0146): one row per connector
 * plan — every service in Vercel's registry, plus the catalog rows it does
 * not list — each configurable, because each plan carries a way in (Vercel's
 * app, a self-registering MCP server, an OAuth preset, an API key, or the
 * generic OAuth integration). Payment rails stay refused (ADR 0086 §6).
 */

import { isBundledProviderId } from "./bundled-provider-ids.js";
import {
  type ConnectPlan,
  connectPlans,
  hasConnectPlan,
  isRefusedPlan,
  isRegistryPlan,
  preferredMethod,
} from "./connect-plan.js";
import type { Connection, Provider } from "./connections.js";
import { isGitBackupProvider } from "./git-backup-forges.js";

/** Host-owned rows keep their own flow (GitHub's App, ADR 0126). */
const HOST_OWNED = new Set(["github"]);

const EMPTY_STRING_LIST: string[] = [];

/**
 * Connect owns a row — draws it from the plan, and is its only road — when
 * Vercel's registry lists the service, when it is a git forge the relay backs
 * up to (Bitbucket, Codeberg, Cursor Origin), or when Pages bundles no row of
 * its own for it. A bundled row keeps its own road, with Connect beside it.
 */
function connectOwns(id: string): boolean {
  if (HOST_OWNED.has(id) || !hasConnectPlan(id)) return false;
  return (
    isRegistryPlan(id) || isGitBackupProvider(id) || !isBundledProviderId(id)
  );
}

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
    docsUrl: plan.docsUrl ?? `https://vercel.com/connect/${plan.id}`,
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

// Built on first use, never at import: this module sits on the boot path of
// every page (the sign-in popup too), and the rows are only drawn by
// Connections.
let catalog: readonly Provider[] | null = null;

function catalogRows(): readonly Provider[] {
  catalog ??= connectPlans()
    .filter((plan) => connectOwns(plan.id))
    .map(toProvider);
  return catalog;
}

/**
 * A row Connect owns: it comes from the plan. Any other bundled catalog row
 * with a plan keeps its own row and road, and gets Connect beside it
 * (`hasConnectRoute`).
 */
export function isVercelCatalogId(id: string): boolean {
  return connectOwns(id);
}

/** Any service a connector can be created for on Vercel Connect. */
export function hasConnectRoute(id: string): boolean {
  return !HOST_OWNED.has(id) && hasConnectPlan(id) && !isRefusedPlan(id);
}

export function isVercelConnectable(id: string): boolean {
  return isVercelCatalogId(id) && !isRefusedPlan(id);
}

export function vercelConnectCatalog(): Provider[] {
  return catalogRows().map((row) => ({ ...row }));
}

/** Vercel browse catalog, then OpenSesame-only bundled rows Vercel does not list. */
export function mergeVercelCatalog(bundled: readonly Provider[]): Provider[] {
  const extra = bundled.filter((row) => !isVercelCatalogId(row.id));
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
  if (isVercelCatalogId(provider.id) && isRefusedPlan(provider.id)) {
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
