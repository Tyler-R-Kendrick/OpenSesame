import { Link, useLocation } from "react-router";
import { crumbsFor } from "../lib/crumbs.js";
import { useVault } from "../lib/vault/hooks.js";
import { IconChevronRight } from "./Icons.js";

function CrumbsDefault() {
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

  const crumbs = crumbsFor(location.pathname, location.search, {
    itemName: item?.name || undefined,
    folderName: folder?.name,
    folderId: folder?.id,
    providerName: providerId ? decodeURIComponent(providerId) : undefined,
    connectionName: connectionId ? decodeURIComponent(connectionId) : undefined,
  });

  if (crumbs.length === 0) return null;

  return (
    <nav className="crumbs" aria-label="Breadcrumb">
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

export const crumbsSeams = {
  Crumbs: CrumbsDefault,
};

export function Crumbs() {
  const Impl = crumbsSeams.Crumbs;
  return <Impl />;
}
