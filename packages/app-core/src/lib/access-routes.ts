import { ACCESS_VIEWS } from "./section-view-names.js";

export type AccessView = (typeof ACCESS_VIEWS)[number];

const ACCESS_VIEW_SET = new Set<string>(ACCESS_VIEWS);

export function isAccessView(value: string): value is AccessView {
  return ACCESS_VIEW_SET.has(value);
}

/** Grants is the Access root, the way general is Settings. */
export function accessPath(view: AccessView): string {
  return view === "grants" ? "/access" : `/access/${view}`;
}

export function accessNewPath(view: AccessView): string {
  return view === "grants" ? "/access/new" : `/access/${view}/new`;
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

/** `/access/connectors` or `/access?view=connectors` → connectors. */
export function accessViewFromLocation(
  pathname: string,
  search = "",
): AccessView {
  const parts = pathname.split("/").filter(Boolean);
  const fromPath = parts[0] === "access" ? parts[1] : undefined;
  if (fromPath === "new" || fromPath === "import") return "grants";
  if (fromPath && isAccessView(fromPath)) return fromPath;
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const view = params.get("view");
  if (view && isAccessView(view)) return view;
  if (params.get("request")) return "requests";
  return "grants";
}

/**
 * The identity-share ceremony, optionally opening with one vault item
 * preselected. A grant is not the same thing as a one-time drop: the item
 * toolbar and row menu use this so "share this item" lands on the form that
 * actually grants access to a person, agent, or application.
 */
export function accessIdentitySharePath(itemId?: string): string {
  const params = new URLSearchParams({ view: "grants" });
  if (itemId) params.set("shareItem", itemId);
  else params.set("draft", "new");
  return `/access?${params.toString()}#identity-shares`;
}
