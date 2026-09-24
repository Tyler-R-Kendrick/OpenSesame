/**
 * SPA rest-path crumbs. Each segment is a real in-app location, not a hash
 * decoration — so refresh, share, and click all land on the same area.
 */

import {
  type ItemKind,
  KIND_LABEL,
  itemTypeRegistry,
  typePlural,
} from "@opensesame/vault-core";
import { accessPath, isAccessView } from "./access-routes.js";
import { contributionsSnapshot } from "./contributions.js";

export type Crumb = {
  label: string;
  /** Absent on the current page. */
  to?: string;
};

/**
 * The categories the core Settings page always has, in tab order —
 * General → Security → Vaults → Capabilities → Danger. `connections` is an
 * older category that now reads as Capabilities (`SETTINGS_HASH_ALIAS`); a
 * module may still contribute a category of its own.
 */
export const SETTINGS_CATEGORIES = [
  "general",
  "security",
  "vaults",
  "capabilities",
  "danger",
] as const;
export type CoreSettingsCategory = (typeof SETTINGS_CATEGORIES)[number];
/** Every category id this code knows how to name; contributed ones included. */
export type SettingsCategory = CoreSettingsCategory | "connections";

export const SETTINGS_CATEGORY_LABEL = {
  general: "General",
  connections: "Connections",
  security: "Security",
  vaults: "Vaults",
  capabilities: "Capabilities",
  danger: "Danger",
} as const satisfies Readonly<Record<SettingsCategory, string>>;

const SETTINGS_LABEL_BY_ID = new Map<string, string>(
  Object.entries(SETTINGS_CATEGORY_LABEL),
);

/** Core categories plus every registered `settings-category`, in order. */
export function settingsCategories(): readonly string[] {
  const contributed = contributionsSnapshot("settings-category")
    .map((entry) => entry.id)
    .filter((id) => !SETTINGS_CATEGORY_SET.has(id));
  return [...SETTINGS_CATEGORIES, ...contributed];
}

/** The label a category is drawn with: authored here, or its contribution's. */
export function settingsCategoryLabel(category: string): string {
  const authored = SETTINGS_LABEL_BY_ID.get(category);
  if (authored !== undefined) return authored;
  return (
    contributionsSnapshot("settings-category").find(
      (entry) => entry.id === category,
    )?.label ?? capitalize(category)
  );
}

function capitalize(segment: string): string {
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

export const WALLET_CATEGORIES = ["budgets", "methods", "passes"] as const;
export type WalletCategory = (typeof WALLET_CATEGORIES)[number];

export const WALLET_CATEGORY_LABEL = {
  budgets: "Budgets",
  passes: "Spending passes",
  methods: "Payment methods",
} satisfies Record<WalletCategory, string>;

/**
 * Legacy hashes and paths that are not themselves a settings category. The
 * Connections, Backups and Cloud secrets categories became Settings ›
 * Capabilities, where each provider is configured under its feature.
 */
const SETTINGS_HASH_ALIAS = new Map<string, string>([
  ["taskbus", "capabilities"],
  ["connectivity", "capabilities"],
  ["connections", "capabilities"],
  ["backups", "capabilities"],
  ["cloud-secrets", "capabilities"],
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
export function vaultFilterLabel(filter: string): string | undefined {
  const fixed = VAULT_FILTER_LABEL.get(filter);
  if (fixed !== undefined) return fixed;
  return itemTypeRegistry().has(filter) ? typePlural(filter) : undefined;
}

const ITEM_KINDS = new Set<string>(Object.keys(KIND_LABEL));
const SETTINGS_CATEGORY_SET = new Set<string>(SETTINGS_CATEGORIES);
const WALLET_CATEGORY_SET = new Set<string>(WALLET_CATEGORIES);

function isItemKind(value: string): value is ItemKind {
  return ITEM_KINDS.has(value);
}

/** A core category, or a contributed one that is registered right now. */
export function isSettingsCategory(value: string): value is SettingsCategory {
  return (
    SETTINGS_CATEGORY_SET.has(value) ||
    contributionsSnapshot("settings-category").some(
      (entry) => entry.id === value,
    )
  );
}

export function isWalletCategory(value: string): value is WalletCategory {
  return WALLET_CATEGORY_SET.has(value);
}

/** `/wallet/methods` → methods; bare `/wallet` → budgets. */
export function walletCategoryFromLocation(pathname: string): WalletCategory {
  const match = pathname.match(/\/wallet\/([^/]+)/);
  const fromPath = match?.[1];
  if (fromPath && isWalletCategory(fromPath)) return fromPath;
  return "budgets";
}

export function walletPath(category: WalletCategory): string {
  return category === "budgets" ? "/wallet" : `/wallet/${category}`;
}

export function settingsCategoryFromHash(
  hash: string,
): SettingsCategory | null {
  const raw = hash.replace(/^#/, "");
  if (isSettingsCategory(raw)) return raw;
  const aliased = SETTINGS_HASH_ALIAS.get(raw);
  return aliased !== undefined && isSettingsCategory(aliased) ? aliased : null;
}

/** `/settings/connections` or `/settings#connectivity` → connections. */
export function settingsCategoryFromLocation(
  pathname: string,
  hash: string,
): SettingsCategory {
  const match = pathname.match(/\/settings\/([^/]+)/);
  const fromPath = match?.[1];
  if (fromPath) {
    const aliased = SETTINGS_HASH_ALIAS.get(fromPath);
    if (aliased !== undefined && isSettingsCategory(aliased)) return aliased;
    if (isSettingsCategory(fromPath)) return fromPath;
  }
  return settingsCategoryFromHash(hash) ?? "general";
}

/** The file name every settings directory carries. */
export const SETTINGS_CONFIG_FILE = "config.yaml";

/**
 * A settings directory's `config.yaml`: the directory's own route with the
 * file named in the query. Not a path segment — a static host answers a
 * missing path that ends in `.yaml` as a missing file, so a reload or a
 * shared link would never reach the app.
 */
export function settingsConfigRoute(category: string): string {
  return settingsFileRoute(category, SETTINGS_CONFIG_FILE);
}

/**
 * Any file a settings directory keeps, by its path (`config.yaml` is the
 * directory's own; the rest are its providers', such as an item type's
 * `settings/item-types/installed/<id>.json`).
 */
export function settingsFileRoute(category: string, file: string): string {
  return `${settingsPath(category)}?file=${encodeURIComponent(file)}`;
}

/** The file a settings location has open, or null for the form. */
export function settingsFileFromSearch(search: string): string | null {
  const file = new URLSearchParams(search).get("file");
  return file === null || file === "" ? null : file;
}

/** Whether a settings location is showing its directory's `config.yaml`. */
export function isSettingsConfigSearch(search: string): boolean {
  return new URLSearchParams(search).get("file") === SETTINGS_CONFIG_FILE;
}

export function settingsPath(category: string, hash = ""): string {
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
  const segment = parts[0];
  if (segment === undefined) return [];
  if (segment === "vault") return vaultCrumbs(parts, params, ctx);
  if (segment === "settings") return settingsCrumbs(parts, params);
  const section = contributionsSnapshot("section").find(
    (entry) => entry.segment === segment,
  );
  // A section that is not in the plan has no path to spell out: the row is
  // its name and nothing under it links anywhere.
  if (section === undefined) return current(capitalize(segment));
  const build = SECTION_CRUMBS.get(segment);
  return build ? build(parts, ctx) : current(section.label);
}

function current(label: string): Crumb[] {
  return [{ label }];
}

/**
 * Crumb builders for the optional sections that spell out a rest path, keyed
 * by the section's segment. A registered section without one is a single
 * current crumb carrying its contributed label.
 */
const SECTION_CRUMBS = new Map<
  string,
  (parts: string[], ctx: CrumbContext) => Crumb[]
>([
  ["connections", (parts, ctx) => connectionsCrumbs(parts, ctx)],
  ["access", (parts) => accessCrumbs(parts)],
  ["wallet", (parts) => walletCrumbs(parts)],
]);

function accessCrumbs(parts: string[]): Crumb[] {
  if (parts[1] === "new") {
    return [{ label: "Access", to: "/access" }, { label: "new" }];
  }
  if (parts[1] === "import") {
    return [{ label: "Access", to: "/access" }, { label: "import" }];
  }
  const tab = parts[1];
  if (!tab || !isAccessView(tab) || tab === "grants") {
    return [{ label: "Access" }];
  }
  const crumbs: Crumb[] = [{ label: "Access", to: "/access" }, { label: tab }];
  if (parts[2] === "new") {
    crumbs[1] = { label: tab, to: accessPath(tab) };
    crumbs.push({ label: "new" });
  }
  return crumbs;
}

export {
  accessImportPath,
  accessIsImportCeremony,
  accessIsNewCeremony,
  accessNewPath,
  accessPath,
  accessViewFromLocation,
} from "./access-routes.js";

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

function walletCrumbs(parts: string[]): Crumb[] {
  const category =
    parts[1] && isWalletCategory(parts[1]) ? parts[1] : "budgets";
  if (category === "budgets") return current("Wallet");
  return [
    { label: "Wallet", to: "/wallet" },
    { label: WALLET_CATEGORY_LABEL[category] },
  ];
}

function settingsCrumbs(parts: string[], params: URLSearchParams): Crumb[] {
  const category = parts[1];
  const aliased = category ? SETTINGS_HASH_ALIAS.get(category) : undefined;
  const named = aliased ?? category ?? "general";
  const file = params.get("file");
  if (isSettingsCategory(named) && file) {
    // A directory's file: the directory is a link, the file is where you are.
    return [
      { label: "Settings", to: "/settings" },
      { label: settingsCategoryLabel(named), to: settingsPath(named) },
      { label: file.slice(file.lastIndexOf("/") + 1) },
    ];
  }
  if (category === "connections" && parts[2]) {
    const provider = decodeURIComponent(parts[2]);
    const crumbs: Crumb[] = [
      { label: "Settings", to: "/settings" },
      { label: "Capabilities", to: "/settings/capabilities" },
      { label: provider },
    ];
    if (parts[3]) {
      crumbs[2] = {
        label: provider,
        to: `/settings/connections/${parts[2]}`,
      };
      crumbs.push({ label: decodeURIComponent(parts[3]) });
    }
    return crumbs;
  }
  if (!isSettingsCategory(named) || named === "general") {
    return [{ label: "Settings" }];
  }
  return [
    { label: "Settings", to: "/settings" },
    { label: settingsCategoryLabel(named) },
  ];
}
