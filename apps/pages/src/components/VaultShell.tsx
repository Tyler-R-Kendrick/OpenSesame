import type { ReactNode } from "react";
import { NavLink, useNavigate } from "react-router";
import {
  IconAgent,
  IconLock,
  IconSettings,
  IconTools,
  IconVault,
} from "./Icons.js";
import { lock } from "../lib/lock.js";

const nav = [
  { to: "/vault", label: "Vault", icon: IconVault, end: false },
  { to: "/agent", label: "Agent", icon: IconAgent, end: false },
  { to: "/tools", label: "Tools", icon: IconTools, end: false },
  { to: "/settings", label: "Settings", icon: IconSettings, end: false },
] as const;

export function VaultShell({
  online,
  children,
}: {
  online: boolean;
  children: ReactNode;
}) {
  const navigate = useNavigate();

  function onLock() {
    lock();
    navigate("/unlock", { replace: true });
  }

  return (
    <div className="vault-app">
      <aside className="vault-sidebar" aria-label="Primary">
        <div className="vault-brand">
          <span className="vault-mark" aria-hidden="true" />
          <div>
            <p className="vault-product">OpenSesame</p>
            <p className="vault-product-sub">Authority vault</p>
          </div>
        </div>
        <nav className="vault-nav">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `vault-nav-link${isActive ? " is-active" : ""}`
              }
            >
              <item.icon />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="vault-sidebar-foot">
          <span
            className={`chip ${online ? "online" : "offline"}`}
            role="status"
            aria-live="polite"
          >
            {online ? "online" : "offline"}
          </span>
          <button type="button" className="lock-btn" onClick={onLock}>
            <IconLock />
            Lock
          </button>
        </div>
      </aside>

      <div className="vault-main">
        <header className="vault-topbar">
          <p className="vault-topbar-title">OpenSesame</p>
          <div className="vault-topbar-actions">
            <span
              className={`chip ${online ? "online" : "offline"}`}
              role="status"
            >
              {online ? "online" : "offline"}
            </span>
            <button type="button" className="lock-btn" onClick={onLock}>
              <IconLock />
              Lock
            </button>
          </div>
        </header>
        <nav className="vault-mobile-nav" aria-label="Primary">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `vault-mobile-link${isActive ? " is-active" : ""}`
              }
            >
              <item.icon />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <main className="vault-content">{children}</main>
      </div>
    </div>
  );
}
