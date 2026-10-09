import {
  type SettingsCategory,
  settingsPath,
} from "@opensesame/app-core/lib/crumbs.js";
import { itemKindsSnapshot } from "@opensesame/app-core/lib/item-kinds.js";

import { sectionForPath } from "./RailRows.js";
import { accessRailPath, walletRailPath } from "./record-rail-path.js";

import { IDENTITY_VIEWS } from "@opensesame/app-core/lib/section-view-names.js";
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
  if (pathname.startsWith("/wallet")) return walletRailPath(pathname, hash);
  if (pathname.startsWith("/vault")) {
    // The report is a page, not a `?f=` filter. A leftover filter must not
    // leave the cursor on `all` or on that filter while the report is open.
    if (pathname === "/vault/health" || pathname === "/vault/health/") {
      return "/vault/health";
    }
    return vaultRailPath(filter, folder, folderKind);
  }
  if (pathname.startsWith("/access")) {
    return accessRailPath(pathname, hash, view);
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
