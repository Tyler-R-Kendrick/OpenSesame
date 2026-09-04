/**
 * SPA rest-path crumbs. Each segment is a real in-app location, not a hash
 * decoration — so refresh, share, and click all land on the same area.
 */

import { itemTypeRegistry, typePlural } from "./vault/item-types.js";
import { type ItemKind, KIND_LABEL } from "./vault/model.js";

export type Crumb = {
  label: string;
  /** Absent on the current page. */
  to?: string;
};

export const ACCESS_TABS = [
  "grants",
  "requests",
  "sessions",
  "resources",
  "policies",
] as const;
export type AccessTab = (typeof ACCESS_TABS)[number];

const ACCESS_TAB_SET = new Set<string>(ACCESS_TABS);

export function isAccessTab(value: string): value is AccessTab {
  return ACCESS_TAB_SET.has(value);
}

/** Grants is the Access root, the way general is Settings. */
export function accessPath(tab: AccessTab): string {
  return tab === "grants" ? "/access" : `/access/${tab}`;
}

export function accessNewPath(tab: AccessTab): string {
  return tab === "grants" ? "/access/new" : `/access/${tab}/new`;
}

export function accessImportPath(): string {
  return "/access/import";
}

export function accessIsNewCeremony(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "access") return false;
  if (parts[1] === "new") return parts.length === 2;
  return parts[2] === "new";
}

export function accessIsImportCeremony(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts[0] === "access" && parts[1] === "import" && parts.length === 2;
}

/** `/access/requests` or `/access?view=requests` → requests. */
export function accessTabFromLocation(
  pathname: string,
  search = "",
): AccessTab {
  const parts = pathname.split("/").filter(Boolean);
  const fromPath = parts[0] === "access" ? parts[1] : undefined;
  if (fromPath === "new" || fromPath === "import") return "grants";
  if (fromPath && isAccessTab(fromPath)) return fromPath;
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const view = params.get("view");
  if (view && isAccessTab(view)) return view;
  if (params.get("request")) return "requests";
  return "grants";
}

export const SETTINGS_CATEGORIES = [
  "general",
  "security",
  "vaults",
  "connectivity",
  "data",
  "danger",
] as const;
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export const SETTINGS_CATEGORY_LABEL = {
  general: "General",
  security: "Security",
  vaults: "Vaults",
  connectivity: "Connectivity",
  data: "Vault data",
  danger: "Danger",
} satisfies Record<SettingsCategory, string>;

const HASH_TO_SETTINGS = new Map<string, SettingsCategory>([
  ["general", "general"],
  ["security", "security"],
  ["vaults", "vaults"],
  ["connectivity", "connectivity"],
  ["data", "data"],
  ["danger", "danger"],
  ["import", "data"],
  ["github-backup", "data"],
  ["taskbus", "connectivity"],
  ["unlock", "security"],
]);

const VAULT_FILTER_LABEL = new Map([
  ["favorites", "Favorites"],
  ["trash", "Trash"],
]);

/**
 * A vault filter is a type id (ADR 0087), so its crumb comes from the type's
 * own definition. The two non-type filters above keep their fixed labels.
 */
function vaultFilterLabel(filter: string): string | undefined {
  const fixed = VAULT_FILTER_LABEL.get(filter);
  if (fixed !== undefined) return fixed;
  return itemTypeRegistry().has(filter) ? typePlural(filter) : undefined;
}

const ITEM_KINDS = new Set<string>(Object.keys(KIND_LABEL));
const SETTINGS_CATEGORY_SET = new Set<string>(SETTINGS_CATEGORIES);

function isItemKind(value: string): value is ItemKind {
  return ITEM_KINDS.has(value);
}

export function isSettingsCategory(value: string): value is SettingsCategory {
  return SETTINGS_CATEGORY_SET.has(value);
}

export function settingsCategoryFromHash(
  hash: string,
): SettingsCategory | null {
  const raw = hash.replace(/^#/, "");
  return HASH_TO_SETTINGS.get(raw) ?? null;
}

/** `/settings/connectivity` or `/settings#connectivity` → connectivity. */
export function settingsCategoryFromLocation(
  pathname: string,
  hash: string,
): SettingsCategory {
  const match = pathname.match(/\/settings\/([^/]+)/);
  const fromPath = match?.[1];
  if (fromPath && isSettingsCategory(fromPath)) return fromPath;
  return settingsCategoryFromHash(hash) ?? "general";
}

export function settingsPath(category: SettingsCategory, hash = ""): string {
  const base = category === "general" ? "/settings" : `/settings/${category}`;
  const fragment = hash.replace(/^#/, "");
  if (!fragment || fragment === category) return base;
  return `${base}#${fragment}`;
}

export type CrumbContext = {
  itemName?: string;
  folderName?: string;
  folderId?: string;
  providerName?: string;
  connectionName?: string;
};

export function crumbsFor(
  pathname: string,
  search = "",
  ctx: CrumbContext = {},
): Crumb[] {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const parts = pathname.split("/").filter(Boolean);

  if (parts[0] === "vault") {
    return vaultCrumbs(parts, params, ctx);
  }
  if (parts[0] === "connections") {
    return connectionsCrumbs(parts, ctx);
  }
  if (parts[0] === "settings") {
    return settingsCrumbs(parts);
  }
  if (parts[0] === "access") {
    return accessCrumbs(parts);
  }
  if (parts[0] === "identity") return current("Identity");
  return [];
}

function current(label: string): Crumb[] {
  return [{ label }];
}

function accessCrumbs(parts: string[]): Crumb[] {
  if (parts[1] === "new") {
    return [{ label: "Access", to: "/access" }, { label: "new" }];
  }
  if (parts[1] === "import") {
    return [{ label: "Access", to: "/access" }, { label: "import" }];
  }
  const tab = parts[1];
  if (!tab || !isAccessTab(tab) || tab === "grants") {
    return [{ label: "Access" }];
  }
  const crumbs: Crumb[] = [{ label: "Access", to: "/access" }, { label: tab }];
  if (parts[2] === "new") {
    crumbs[1] = { label: tab, to: accessPath(tab) };
    crumbs.push({ label: "new" });
  }
  return crumbs;
}

function vaultCrumbs(
  parts: string[],
  params: URLSearchParams,
  ctx: CrumbContext,
): Crumb[] {
  const crumbs: Crumb[] = [{ label: "Vault", to: "/vault" }];
  const rest = parts.slice(1);
  const folderId = params.get("folder") ?? ctx.folderId;
  const filter = params.get("f");

  if (rest[0] === "health") {
    crumbs.push({ label: "Password health" });
    return crumbs;
  }
  if (rest[0] === "new" && rest[1] && isItemKind(rest[1])) {
    const kind = rest[1];
    crumbs.push({ label: `New ${KIND_LABEL[kind].toLowerCase()}` });
    return crumbs;
  }
  if (rest[0] && rest[0] !== "new") {
    if (folderId && ctx.folderName) {
      crumbs.push({
        label: ctx.folderName,
        to: `/vault?folder=${encodeURIComponent(folderId)}`,
      });
    }
    crumbs.push({ label: ctx.itemName || "Item" });
    if (rest[1] === "edit") crumbs.push({ label: "Edit" });
    return crumbs;
  }
  if (folderId && ctx.folderName) {
    crumbs.push({ label: ctx.folderName });
    return crumbs;
  }
  const filterLabel = filter ? vaultFilterLabel(filter) : undefined;
  if (filterLabel) {
    crumbs.push({ label: filterLabel });
    return crumbs;
  }
  return [{ label: "Vault" }];
}

function connectionsCrumbs(parts: string[], ctx: CrumbContext): Crumb[] {
  const crumbs: Crumb[] = [{ label: "Connections", to: "/connections" }];
  const provider = parts[1];
  if (!provider) return [{ label: "Connections" }];
  const providerLabel = ctx.providerName || decodeURIComponent(provider);
  const connection = parts[2];
  if (!connection) {
    crumbs.push({ label: providerLabel });
    return crumbs;
  }
  crumbs.push({
    label: providerLabel,
    to: `/connections/${provider}`,
  });
  crumbs.push({
    label: ctx.connectionName || decodeURIComponent(connection),
  });
  return crumbs;
}

function settingsCrumbs(parts: string[]): Crumb[] {
  const category = parts[1];
  if (!category || !isSettingsCategory(category) || category === "general") {
    return [{ label: "Settings" }];
  }
  return [
    { label: "Settings", to: "/settings" },
    { label: SETTINGS_CATEGORY_LABEL[category] },
  ];
}
