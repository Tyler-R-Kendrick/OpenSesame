import {
  type SettingsCategory,
  settingsPath,
  walletCategoryFromLocation,
  walletPath,
} from "../lib/crumbs.js";
import { itemKindsSnapshot } from "../lib/item-kinds.js";
import { ACCESS_VIEWS, IDENTITY_VIEWS } from "../lib/section-views.js";
import { sectionForPath } from "./RailRows.js";

export function selectedRailPath(
  pathname: string,
  hash: string,
  view: string | null,
  filter: string,
  folder: string | null,
  category: SettingsCategory,
  folderKind: string | null = null,
): string {
  if (pathname.startsWith("/settings")) {
    if (pathname.startsWith("/settings/connections/")) {
      return pathname;
    }
    const base = settingsPath(category);
    if (category === "connections" && hash.startsWith("#") && hash.length > 1) {
      return `${base}${hash}`;
    }
    return base;
  }
  if (pathname.startsWith("/wallet"))
    return walletPath(walletCategoryFromLocation(pathname));
  if (pathname.startsWith("/vault"))
    return vaultRailPath(filter, folder, folderKind);
  if (pathname.startsWith("/access")) {
    const id = ACCESS_VIEWS.find((item) => item === view) ?? "grants";
    return `/access?view=${id}${hash}`;
  }
  if (pathname.startsWith("/identity")) {
    const id = IDENTITY_VIEWS.find((item) => item === view) ?? "people";
    return `/identity?view=${id}${hash}`;
  }
  if (pathname.startsWith("/connections")) {
    return (
      pathname + (hash || (pathname === "/connections" ? "#connected" : ""))
    );
  }
  return sectionForPath(pathname)?.to ?? "/vault";
}

function vaultRailPath(
  filter: string,
  folder: string | null,
  folderKind: string | null,
) {
  if (!folder) return filter === "all" ? "/vault" : `/vault?f=${filter}`;
  const kind = itemKindsSnapshot().some((entry) => entry.id === filter)
    ? filter
    : folderKind;
  return kind
    ? `/vault?f=${kind}&folder=${encodeURIComponent(folder)}`
    : `/vault?folder=${encodeURIComponent(folder)}`;
}
