import { type SettingsCategory, settingsPath } from "../lib/crumbs.js";
import { ACCESS_VIEWS, IDENTITY_VIEWS } from "../lib/section-views.js";
import { KIND_SEGMENTS, SECTIONS } from "./RailRows.js";

export function selectedRailPath(
  pathname: string,
  hash: string,
  view: string | null,
  filter: string,
  folder: string | null,
  category: SettingsCategory,
  folderKind: string | null = null,
): string {
  if (pathname.startsWith("/settings")) return settingsPath(category);
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
  return SECTIONS.find(({ to }) => pathname.startsWith(to))?.to ?? "/vault";
}

function vaultRailPath(
  filter: string,
  folder: string | null,
  folderKind: string | null,
) {
  if (!folder) return filter === "all" ? "/vault" : `/vault?f=${filter}`;
  const kind = KIND_SEGMENTS.some((entry) => entry.id === filter)
    ? filter
    : folderKind;
  return kind
    ? `/vault?f=${kind}&folder=${encodeURIComponent(folder)}`
    : `/vault?folder=${encodeURIComponent(folder)}`;
}
