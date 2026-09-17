import { ACCESS_VIEWS } from "./section-views.js";

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

export function grantCeremonyPath(
  input: { connectionId?: string; secretId?: string } | null,
): string {
  const base = accessNewPath("grants");
  if (input === null) return base;
  if (input.connectionId) {
    return `${base}?connection=${encodeURIComponent(input.connectionId)}`;
  }
  if (input.secretId) {
    return `${base}?secret=${encodeURIComponent(input.secretId)}`;
  }
  return base;
}
