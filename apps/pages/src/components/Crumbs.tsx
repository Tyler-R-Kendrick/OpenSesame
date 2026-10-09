import { type Crumb, crumbsFor } from "@opensesame/app-core/lib/crumbs.js";
import { subscribeDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceConnectorDisplayName } from "@opensesame/app-core/lib/device-connector-view.js";
import { useSyncExternalStore } from "react";
import { Link, useLocation } from "react-router";
import { useNarrow } from "../lib/use-narrow.js";
import { useVault } from "../lib/vault/hooks.js";
import { IconChevronRight } from "./Icons.js";

function tabOrFilter(
  pathname: string,
  folderId: string | null,
  narrow: boolean,
): boolean {
  if (/^\/(settings|wallet)\/[^/]+$/.test(pathname)) return true;
  // Access marks its tab under the title as Settings does. On a phone the
  // crumb row appeared only on the sub-tabs and pushed the title 49px down
  // against the first tab; a wide screen keeps the row it has always drawn.
  if (narrow && /^\/access\/[^/]+$/.test(pathname)) return true;
  return pathname === "/vault" && !folderId;
}

function connectionSegments(parts: string[]): string[] {
  if (parts[0] === "connections") return parts.slice(1, 3);
  if (parts[0] === "settings" && parts[1] === "connections")
    return parts.slice(2, 4);
  return [];
}

function connectionLabel(
  providerId: string | undefined,
  connectionId: string | undefined,
): string | undefined {
  if (!providerId || !connectionId) return undefined;
  const id = decodeURIComponent(connectionId);
  return (
    deviceConnectorDisplayName(decodeURIComponent(providerId), id) ??
    (id.startsWith("devconn_") ? "Connection" : id)
  );
}

/** The path to the current route, from the vault's items and folders. */
export function useCrumbs(): Crumb[] {
  const location = useLocation();
  const { items, folders } = useVault();
  const parts = location.pathname.split("/").filter(Boolean);
  const vaultLeaf = parts[0] === "vault" ? parts[1] : undefined;
  const itemId =
    vaultLeaf && vaultLeaf !== "health" && vaultLeaf !== "new"
      ? vaultLeaf
      : undefined;
  const item = itemId
    ? items.find((candidate) => candidate.id === itemId)
    : undefined;
  const folderId =
    item?.folderId ?? new URLSearchParams(location.search).get("folder");
  const folder = folderId
    ? folders.find((candidate) => candidate.id === folderId)
    : undefined;
  const [providerId, connectionId] = connectionSegments(parts);
  const connectionName = useSyncExternalStore(subscribeDeviceRows, () =>
    connectionLabel(providerId, connectionId),
  );

  return crumbsFor(location.pathname, location.search, {
    itemName: item?.name || undefined,
    folderName: folder?.name,
    folderId: folder?.id,
    providerName: providerId ? decodeURIComponent(providerId) : undefined,
    connectionName,
  });
}

/** One trail of links, ending on the page itself. */
export function CrumbTrail({
  crumbs,
  className,
  label,
}: {
  crumbs: readonly Crumb[];
  className: string;
  label: string;
}) {
  return (
    <nav className={className} aria-label={label}>
      <ol className="crumbs__list">
        {crumbs.map((crumb, index) => (
          <li
            key={`${crumb.label}:${crumb.to ?? "here"}`}
            className="crumbs__item"
          >
            {index > 0 ? (
              <IconChevronRight size={12} className="crumbs__sep" />
            ) : null}
            {crumb.to ? (
              <Link to={crumb.to}>{crumb.label}</Link>
            ) : (
              <span className="crumbs__here" aria-current="page">
                {crumb.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function CrumbsDefault() {
  const location = useLocation();
  const crumbs = useCrumbs();
  const narrow = useNarrow();
  const folderId = new URLSearchParams(location.search).get("folder");

  // A breadcrumb with one item is not a breadcrumb, it is a label — and it is
  // the one label both navs already carry: the tab bar marks the section on a
  // phone and the rail marks it on a desktop. Drawing "Vault" under a "Vault"
  // tab spent a row of the frame saying nothing. Two or more is a path, which
  // neither nav shows, so that row stays.
  if (
    crumbs.length < 2 ||
    /^\/(identity|access|wallet)(?:\/|$)/.test(location.pathname)
  )
    return null;
  // Nor is "Settings › Vaults" or "Vault › Accounts" when the page already
  // marks that second step — the selected tab under the title, the filter
  // the list is showing. Drawn only on those sub-views, it pushed the title
  // 24px down against its sibling tabs; a path the page does not already
  // show (an item, a folder, a connector) keeps the row.
  if (crumbs.length === 2 && tabOrFilter(location.pathname, folderId, narrow)) {
    return null;
  }

  // Beside a vault's list the path is the list pane's own strip
  // (VaultPathbar); this row is a phone's, where the list is a screen away.
  const vault = location.pathname.split("/")[1] === "vault";
  return (
    <CrumbTrail
      crumbs={crumbs}
      className={vault ? "crumbs crumbs--vault" : "crumbs"}
      label="Breadcrumb"
    />
  );
}

export const crumbsSeams = {
  Crumbs: CrumbsDefault,
};

export function Crumbs() {
  const Impl = crumbsSeams.Crumbs;
  return <Impl />;
}
