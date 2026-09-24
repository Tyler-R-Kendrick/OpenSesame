import { type Crumb, crumbsFor } from "@opensesame/app-core/lib/crumbs.js";
import { Link, useLocation } from "react-router";
import { useVault } from "../lib/vault/hooks.js";
import { IconChevronRight } from "./Icons.js";

function tabOrFilter(pathname: string, folderId: string | null): boolean {
  if (/^\/(settings|wallet)\/[^/]+$/.test(pathname)) return true;
  return pathname === "/vault" && !folderId;
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
  const providerId = parts[0] === "connections" ? parts[1] : undefined;
  const connectionId = parts[0] === "connections" ? parts[2] : undefined;

  return crumbsFor(location.pathname, location.search, {
    itemName: item?.name || undefined,
    folderName: folder?.name,
    folderId: folder?.id,
    providerName: providerId ? decodeURIComponent(providerId) : undefined,
    connectionName: connectionId ? decodeURIComponent(connectionId) : undefined,
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
  const folderId = new URLSearchParams(location.search).get("folder");

  // A breadcrumb with one item is not a breadcrumb, it is a label — and it is
  // the one label both navs already carry: the tab bar marks the section on a
  // phone and the rail marks it on a desktop. Drawing "Vault" under a "Vault"
  // tab spent a row of the frame saying nothing. Two or more is a path, which
  // neither nav shows, so that row stays.
  if (crumbs.length < 2) return null;
  // Nor is "Settings › Vaults" or "Vault › Logins" when the page already
  // marks that second step — the selected tab under the title, the filter
  // the list is showing. Drawn only on those sub-views, it pushed the title
  // 24px down against its sibling tabs; a path the page does not already
  // show (an item, a folder, a connector) keeps the row.
  if (crumbs.length === 2 && tabOrFilter(location.pathname, folderId)) {
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
