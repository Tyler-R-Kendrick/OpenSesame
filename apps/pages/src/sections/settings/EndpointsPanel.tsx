import { useState } from "react";
import { FieldShell } from "../../components/FieldShell.js";
import {
  IconAuthority,
  IconLogin,
  IconPhone,
  IconTerminal,
} from "../../components/Icons.js";
import { StatusNote } from "../../components/StatusNote.js";
import {
  checkTurso,
  setTursoSessionToken,
} from "../../lib/embedded-catalog.js";
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
  checkTurso,
  setTursoSessionToken,
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
  const [open, setOpen] = useState(false);
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
    return saved.has(key) ? <span className="chip chip--ok">Saved</span> : null;
  }

  /** Only offer a default that is not already in the box. */
  function fill(key: EndpointKey, value: string) {
    if (!value || settings[key] === value) return [];
    return [{ label: value, onPick: () => edit(key, value) }];
  }

  return (
    <section className="panel" id="endpoints">
      <div className="panel__head">
        <div>
          <h2>Endpoints</h2>
          <p>
            Filled in by the connection ceremonies above. Edit them by hand only
            when you are pointing at a plane someone else runs. Changes save
            when you leave the field.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--sm"
          aria-expanded={open}
          aria-controls="endpoints-body"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide" : "Edit by hand"}
        </button>
      </div>
      {open ? (
        <div className="panel__body" id="endpoints-body">
          <FieldShell
            id="host-api"
            label="Host API"
            type="url"
            mono
            lead={<IconAuthority size={17} />}
            placeholder="http://127.0.0.1:18787"
            value={settings.hostApi}
            status={savedChip("hostApi")}
            onValueChange={(value) => edit("hostApi", value)}
            onCommit={(value) => commit("hostApi", value)}
            fills={fill(
              "hostApi",
              endpointsPanelDependencies.pageIsLoopback() ? shippedHostApi : "",
            )}
          />
          <FieldShell
            id="identity-api"
            label="Identity API"
            type="url"
            mono
            lead={<IconLogin size={17} />}
            placeholder="http://127.0.0.1:18788"
            value={settings.identityApi}
            status={savedChip("identityApi")}
            onValueChange={(value) => edit("identityApi", value)}
            onCommit={(value) => commit("identityApi", value)}
            fills={fill(
              "identityApi",
              endpointsPanelDependencies.pageIsLoopback()
                ? shippedIdentityApi
                : "",
            )}
          />
          <FieldShell
            id="daemon-api"
            label="Daemon on this machine"
            type="url"
            mono
            lead={<IconTerminal size={17} />}
            placeholder="https://your-machine.tailnet.ts.net"
            value={settings.daemonApi}
            status={savedChip("daemonApi")}
            onValueChange={(value) => edit("daemonApi", value)}
            onCommit={(value) => commit("daemonApi", value)}
            fills={fill(
              "daemonApi",
              endpointsPanelDependencies.pageIsLoopback()
                ? shippedDaemonApi
                : "",
            )}
            hint={
              <>
                Local Pages keep Host and Identity on loopback after pairing.
                The Tailscale Serve URL is what github.io and other devices use
                — this page cannot call <code>127.0.0.1</code>.
              </>
            }
          />
          <FieldShell
            id="mfa-app-url"
            label="Mobile MFA app"
            type="url"
            mono
            lead={<IconPhone size={17} />}
            placeholder="http://127.0.0.1:5177"
            value={settings.mfaAppUrl}
            status={savedChip("mfaAppUrl")}
            onValueChange={(value) => edit("mfaAppUrl", value)}
            onCommit={(value) => commit("mfaAppUrl", value)}
            hint="When this browser cannot finish a passkey, the passkey note shows a QR that opens this URL on your phone."
          />
        </div>
      ) : null}
    </section>
  );
}

/**
 * Turso is off unless someone turns it on, and turning it on takes a URL plus
 * a token that is deliberately never persisted. That is a form, and it stays
 * one — but it is no longer wedged into the middle of the endpoint list.
 */
export function TursoSyncPanel() {
  const [tursoUrl, setTursoUrl] = useState(
    () => endpointsPanelDependencies.loadSettings().tursoUrl,
  );
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<{
    tone: "ok" | "err";
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  async function apply() {
    setBusy(true);
    try {
      endpointsPanelDependencies.saveSettings({
        ...endpointsPanelDependencies.loadSettings(),
        tursoUrl: tursoUrl.trim(),
      });
      endpointsPanelDependencies.setTursoSessionToken(token);
      const mode = await endpointsPanelDependencies.checkTurso();
      setStatus({
        tone: mode === "memory" ? "err" : "ok",
        text:
          mode === "remote"
            ? "Turso is embedded in this PWA and synchronized with the configured remote."
            : mode === "embedded"
              ? "Turso is running inside this PWA and persisting the connector catalog in OPFS."
              : "Turso could not open; this tab is using the bundled connector catalog in memory.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" id="turso">
      <div className="panel__head">
        <div>
          <h2>Turso sync</h2>
          <p>
            Optional. Blank keeps the connector catalog entirely inside this
            PWA; a URL plus a token enables explicit push/pull sync.
          </p>
        </div>
      </div>
      <div className="panel__body">
        <FieldShell
          id="turso-url"
          label="Sync URL"
          type="url"
          mono
          placeholder="libsql://database-name.turso.io"
          value={tursoUrl}
          onValueChange={setTursoUrl}
        />
        <FieldShell
          id="turso-token"
          label="Auth token (this tab only)"
          type="password"
          autoComplete="off"
          placeholder="Only needed for remote sync"
          value={token}
          onValueChange={setToken}
          hint="Never written to OPFS or the vault. Paste it again after a reload when remote sync is needed."
        />
        <StatusNote message={status} />
        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void apply()}
          >
            {busy ? "Checking…" : "Apply and check"}
          </button>
        </div>
      </div>
    </section>
  );
}
