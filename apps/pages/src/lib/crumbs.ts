/**
 * SPA rest-path crumbs. Each segment is a real in-app location, not a hash
 * decoration — so refresh, share, and click all land on the same area.
 */

import { type ItemKind, KIND_LABEL, KIND_PLURAL } from "./vault/model.js";

export type Crumb = {
  label: string;
  /** Absent on the current page. */
  to?: string;
};

export const SETTINGS_CATEGORIES = [
  "general",
  "security",
  "connectivity",
  "data",
  "danger",
] as const;
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export const SETTINGS_CATEGORY_LABEL: Record<SettingsCategory, string> = {
  general: "General",
  security: "Security",
  connectivity: "Connectivity",
  data: "Vault data",
  danger: "Danger",
};

const HASH_TO_SETTINGS: Record<string, SettingsCategory> = {
  general: "general",
  security: "security",
  connectivity: "connectivity",
  data: "data",
  danger: "danger",
  import: "data",
  "github-backup": "data",
  taskbus: "connectivity",
  unlock: "security",
};

const VAULT_FILTER_LABEL: Record<string, string> = {
  favorites: "Favorites",
  trash: "Trash",
  login: KIND_PLURAL.login,
  passkey: KIND_PLURAL.passkey,
  card: KIND_PLURAL.card,
  secret: KIND_PLURAL.secret,
  note: KIND_PLURAL.note,
  certificate: "Certificates",
};

const ITEM_KINDS = new Set<string>(Object.keys(KIND_LABEL));

export function isSettingsCategory(value: string): value is SettingsCategory {
  return (SETTINGS_CATEGORIES as readonly string[]).includes(value);
}

export function settingsCategoryFromHash(
  hash: string,
): SettingsCategory | null {
  const raw = hash.replace(/^#/, "");
  return HASH_TO_SETTINGS[raw] ?? null;
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
  if (parts[0] === "agents") return current("Agents");
  if (parts[0] === "sites") return current("Sites");
  if (parts[0] === "authority") return current("Authority");
  return [];
}

function current(label: string): Crumb[] {
  return [{ label }];
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
  if (rest[0] === "new" && rest[1] && ITEM_KINDS.has(rest[1])) {
    const kind = rest[1] as ItemKind;
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
  if (filter && VAULT_FILTER_LABEL[filter]) {
    crumbs.push({ label: VAULT_FILTER_LABEL[filter] });
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
