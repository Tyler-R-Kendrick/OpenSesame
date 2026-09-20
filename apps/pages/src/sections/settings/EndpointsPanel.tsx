import { type ReactNode, useState } from "react";
import { FieldShell } from "../../components/FieldShell.js";
import {
  IconAuthority,
  IconLogin,
  IconPhone,
  IconTerminal,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import {
  type PagesSettings,
  loadSettings,
  pageIsLoopback,
  saveSettings,
  shippedDaemonApi,
  shippedHostApi,
  shippedIdentityApi,
} from "../../lib/settings.js";

export const endpointsPanelDependencies = {
  loadSettings,
  saveSettings,
  pageIsLoopback,
};

/**
 * Endpoints, collapsed.
 *
 * Pairing writes all three of these and says so when it does, so the panel
 * opens closed: editing by hand is for pointing at a plane someone else runs.
 * There is no Save button either — a settings pane cannot be half-entered, so
 * each field commits on blur and says "Saved" beside its own label.
 */
type EndpointKey = "hostApi" | "identityApi" | "daemonApi" | "mfaAppUrl";

const TRAILING_SLASH = /\/$/;

export function EndpointsPanel() {
  const [settings, setSettings] = useState<PagesSettings>(() =>
    endpointsPanelDependencies.loadSettings(),
  );
  const [open, setOpen] = useState<EndpointKey | null>(null);
  const [saved, setSaved] = useState<Set<EndpointKey>>(() => new Set());

  function commit(key: EndpointKey, raw: string) {
    const value = raw.trim().replace(TRAILING_SLASH, "");
    const current = endpointsPanelDependencies.loadSettings();
    if (current[key] === value) return;
    endpointsPanelDependencies.saveSettings({ ...current, [key]: value });
    setSettings(endpointsPanelDependencies.loadSettings());
    setSaved((previous) => new Set(previous).add(key));
  }

  function edit(key: EndpointKey, value: string) {
    setSettings((previous) => ({ ...previous, [key]: value }));
    setSaved((previous) => {
      if (!previous.has(key)) return previous;
      const next = new Set(previous);
      next.delete(key);
      return next;
    });
  }

  function savedChip(key: EndpointKey) {
    return saved.has(key) ? <StatusMark tone="ok" label="Saved" /> : null;
  }

  function fill(key: EndpointKey, value: string) {
    if (!value || settings[key] === value) return [];
    return [{ label: value, onPick: () => edit(key, value) }];
  }

  const rows: ReadonlyArray<{
    key: EndpointKey;
    label: string;
    placeholder: string;
    lead: ReactNode;
    fill: string;
  }> = [
    {
      key: "hostApi",
      label: "Host API",
      placeholder: "http://127.0.0.1:18787",
      lead: <IconAuthority size={17} />,
      fill: endpointsPanelDependencies.pageIsLoopback() ? shippedHostApi : "",
    },
    {
      key: "identityApi",
      label: "Identity API",
      placeholder: "http://127.0.0.1:18788",
      lead: <IconLogin size={17} />,
      fill: endpointsPanelDependencies.pageIsLoopback()
        ? shippedIdentityApi
        : "",
    },
    {
      key: "daemonApi",
      label: "Daemon on this machine",
      placeholder: "https://your-machine.tailnet.ts.net",
      lead: <IconTerminal size={17} />,
      fill: endpointsPanelDependencies.pageIsLoopback() ? shippedDaemonApi : "",
    },
    {
      key: "mfaAppUrl",
      label: "Mobile MFA app",
      placeholder: "http://127.0.0.1:5177",
      lead: <IconPhone size={17} />,
      fill: "",
    },
  ];

  return (
    <div className="conn-group" id="endpoints">
      <h3 className="conn-group__label">Endpoints</h3>
      <ul className="conn-grid">
        {rows.map((row) => (
          <li className="conn-tile" key={row.key}>
            <button
              type="button"
              className="conn-tile__link"
              aria-expanded={open === row.key}
              aria-label={row.label}
              title={row.label}
              onClick={() =>
                setOpen((current) => (current === row.key ? null : row.key))
              }
            >
              {row.lead}
              <span className="conn-tile__name">{row.label}</span>
              {savedChip(row.key)}
            </button>
            {open === row.key ? (
              <div className="conn-tile__body">
                <FieldShell
                  id={row.key}
                  label={row.label}
                  type="url"
                  mono
                  placeholder={row.placeholder}
                  value={settings[row.key]}
                  status={savedChip(row.key)}
                  onValueChange={(value) => edit(row.key, value)}
                  onCommit={(value) => commit(row.key, value)}
                  fills={fill(row.key, row.fill)}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
