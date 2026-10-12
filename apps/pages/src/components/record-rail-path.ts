import { accessViewFromLocation } from "@opensesame/app-core/lib/access-routes.js";
import { walletCategoryFromLocation } from "@opensesame/app-core/lib/crumbs.js";

/** A share's collection URL and its existing subtree leaf name the same record. */
export function accessRailHash(hash: string): string {
  if (hash.startsWith("#identity-shares/"))
    return `#share-${hash.slice("#identity-shares/".length)}`;
  if (hash.startsWith("#share-")) return hash;
  if (hash.startsWith("#pending-")) return "#identity-shares";
  if (hash.startsWith("#vault-session-")) return "#vault-share-sessions";
  return hash.split("/")[0] ?? "";
}

export function accessRailPath(
  pathname: string,
  hash: string,
  view: string | null,
): string {
  const id = accessViewFromLocation(
    pathname,
    view ? `?view=${encodeURIComponent(view)}` : "",
  );
  return `/access?view=${id}${accessRailHash(hash)}`;
}

export function walletRailPath(pathname: string, hash: string): string {
  return `/wallet/${walletCategoryFromLocation(pathname)}${hash}`;
}
