import { type ReactNode, useMemo } from "react";
import { NavLink, useLocation, useSearchParams } from "react-router";
import { useIdentitySession } from "../lib/identity.js";
import { useOnline } from "../lib/use-online.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import type { ItemKind } from "../lib/vault/model.js";
import {
  IconAgent,
  IconAuthority,
  IconCard,
  IconConnection,
  IconFolder,
  IconLogin,
  IconNote,
  IconPasskey,
  IconSecret,
  IconSettings,
  IconShield,
  IconSite,
  IconStar,
  IconTrash,
  IconVault,
} from "./Icons.js";

const SECTIONS = [
  { to: "/vault", label: "Vault", Icon: IconVault },
  { to: "/agents", label: "Agents", Icon: IconAgent },
  { to: "/connections", label: "Connections", Icon: IconConnection },
  { to: "/sites", label: "Sites", Icon: IconSite },
  { to: "/authority", label: "Authority", Icon: IconAuthority },
  { to: "/settings", label: "Settings", Icon: IconSettings },
] as const;

const KIND_FILTERS: Array<{
  id: ItemKind;
  label: string;
  Icon: typeof IconLogin;
}> = [
  { id: "login", label: "Logins", Icon: IconLogin },
  { id: "passkey", label: "Passkeys", Icon: IconPasskey },
  { id: "card", label: "Cards", Icon: IconCard },
  { id: "secret", label: "Agent secrets", Icon: IconSecret },
  { id: "note", label: "Secure notes", Icon: IconNote },
];

function VaultFilters() {
  const [params] = useSearchParams();
  const { items, folders } = useVault();
  const active = params.get("f") ?? "all";
  const activeFolder = params.get("folder");

  const counts = useMemo(() => {
    const live = items.filter((item) => item.deletedAt === null);
    const byKind = new Map<ItemKind, number>();
    const byFolder = new Map<string, number>();
    for (const item of live) {
      byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
      if (item.folderId) {
        byFolder.set(item.folderId, (byFolder.get(item.folderId) ?? 0) + 1);
      }
    }
    return {
      all: live.length,
      favorites: live.filter((item) => item.favorite).length,
      trash: items.length - live.length,
      byKind,
      byFolder,
    };
  }, [items]);

  const link = (query: string, isActive: boolean, children: ReactNode) => (
    <NavLink
      key={query || "all"}
      to={`/vault${query}`}
      className={`rail__link${isActive ? " is-active" : ""}`}
      end
    >
      {children}
    </NavLink>
  );

  return (
    <>
      <div className="rail__group">
        <p className="rail__group-label">Vault</p>
        {link(
          "",
          active === "all" && !activeFolder,
          <>
            <IconVault size={18} />
            <span>All items</span>
            <span className="rail__count">{counts.all}</span>
          </>,
        )}
        {link(
          "?f=favorites",
          active === "favorites",
          <>
            <IconStar size={18} />
            <span>Favorites</span>
            <span className="rail__count">{counts.favorites}</span>
          </>,
        )}
        {KIND_FILTERS.map(({ id, label, Icon }) =>
          link(
            `?f=${id}`,
            active === id,
            <>
              <Icon size={18} />
              <span>{label}</span>
              <span className="rail__count">{counts.byKind.get(id) ?? 0}</span>
            </>,
          ),
        )}
        {link(
          "?f=trash",
          active === "trash",
          <>
            <IconTrash size={18} />
            <span>Trash</span>
            <span className="rail__count">{counts.trash}</span>
          </>,
        )}
      </div>

      {folders.length > 0 ? (
        <div className="rail__group">
          <p className="rail__group-label">Folders</p>
          {folders.map((folder) =>
            link(
              `?folder=${encodeURIComponent(folder.id)}`,
              activeFolder === folder.id,
              <>
                <IconFolder size={18} />
                <span>{folder.name}</span>
                <span className="rail__count">
                  {counts.byFolder.get(folder.id) ?? 0}
                </span>
              </>,
            ),
          )}
        </div>
      ) : null}

      <div className="rail__group">
        <p className="rail__group-label">Review</p>
        <NavLink
          to="/vault/health"
          className={({ isActive }) =>
            `rail__link${isActive ? " is-active" : ""}`
          }
        >
          <IconShield size={18} />
          <span>Password health</span>
        </NavLink>
      </div>
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const online = useOnline();
  const session = useIdentitySession();
  const store = useVaultStore();
  const inVault = location.pathname.startsWith("/vault");

  return (
    <div className="app">
      <aside className="rail">
        <div className="rail__brand">
          <span className="mark" aria-hidden="true">
            <IconVault size={17} />
          </span>
          <div>
            <p className="rail__wordmark">OpenSesame</p>
            <p className="rail__tagline">Encrypted vault</p>
          </div>
        </div>

        <div className="rail__scroll">
          <nav aria-label="Sections">
            {SECTIONS.map(({ to, label, Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `rail__link${isActive ? " is-active" : ""}`
                }
              >
                <Icon size={18} />
                <span>{label}</span>
              </NavLink>
            ))}
          </nav>
          {inVault ? <VaultFilters /> : null}
        </div>

        <div className="rail__foot">
          <p className="rail__status">
            <span
              className={`dot ${online ? "dot--ok" : "dot--warn"}`}
              aria-hidden="true"
            />
            {online ? "Online" : "Offline"}
            <span aria-hidden="true">·</span>
            {session ? "Identity connected" : "No identity session"}
          </p>
          <button type="button" className="rail__lock" onClick={store.lock}>
            Lock vault
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <span className="mark" aria-hidden="true">
            <IconVault size={17} />
          </span>
          <p className="topbar__title">OpenSesame</p>
          <span className="topbar__spacer" />
          <output
            className={`dot ${online ? "dot--ok" : "dot--warn"}`}
            aria-label={online ? "Online" : "Offline"}
          />
          <button type="button" className="rail__lock" onClick={store.lock}>
            Lock
          </button>
        </header>

        {children}

        <nav className="tabbar" aria-label="Sections">
          {SECTIONS.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `tabbar__link${isActive ? " is-active" : ""}`
              }
            >
              <Icon size={20} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
