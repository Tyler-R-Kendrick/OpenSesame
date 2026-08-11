import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { IconPlus, IconRefresh, IconTrash } from "../components/Icons.js";
import {
  type Connection,
  type Provider,
  createConnection,
  listConnections,
  listProviders,
  removeConnection,
  testProvider,
} from "../lib/credential-providers.js";
import { hostBase, useConnect, useIdentitySession } from "../lib/identity.js";
import "./connections.css";

type Notice = { tone: "ok" | "err"; text: string } | null;

export function ConnectionsSection() {
  const session = useIdentitySession();
  const connect = useConnect();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const refresh = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setNotice(null);
    try {
      const [nextProviders, nextConnections] = await Promise.all([
        listProviders(),
        listConnections(),
      ]);
      setProviders(nextProviders);
      setConnections(nextConnections);
    } catch (error) {
      setNotice({
        tone: "err",
        text:
          error instanceof Error
            ? error.message
            : "Could not load connections.",
      });
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!session) {
    return (
      <div className="section__inner">
        <Header />
        <section className="panel">
          <div className="panel__body connections-connect">
            <h2>Connect your identity</h2>
            <p className="hint">
              OpenSesame mints a short-lived Host session scoped to you.
              Deployment operator credentials are never entered or stored in
              this page.
            </p>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void connect.connect()}
              disabled={connect.connecting}
            >
              {connect.connecting ? "Connecting…" : "Connect"}
            </button>
            {connect.error ? (
              <p className="note note--err">{connect.error}</p>
            ) : null}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="section__inner">
      <Header />
      {notice ? (
        <p className={`note note--${notice.tone}`}>{notice.text}</p>
      ) : null}
      <NewConnection
        providers={providers}
        onCreated={(connection) => {
          setConnections((current) => [...current, connection]);
          setNotice({
            tone: "ok",
            text: `${connection.displayName} was added.`,
          });
        }}
      />
      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>Configured connections</h2>
            <p>Credential material stays behind its provider adapter.</p>
          </div>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <IconRefresh size={15} /> {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        <div className="panel__body">
          {connections.length === 0 ? (
            <p className="hint">No connections configured yet.</p>
          ) : (
            <ul className="connections-list">
              {connections.map((connection) => (
                <ConnectionRow
                  key={connection.id}
                  connection={connection}
                  provider={providers.find(
                    (item) => item.id === connection.providerId,
                  )}
                  onRemoved={() =>
                    setConnections((current) =>
                      current.filter((item) => item.id !== connection.id),
                    )
                  }
                  setNotice={setNotice}
                />
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function Header() {
  return (
    <header className="section__head">
      <h1>Connections</h1>
      <p>
        Cloud secret managers, password managers, encrypted storage, hardware
        keys, and short-lived lease providers. Host: <code>{hostBase()}</code>
      </p>
    </header>
  );
}

function NewConnection({
  providers,
  onCreated,
}: {
  providers: Provider[];
  onCreated: (connection: Connection) => void;
}) {
  const [providerId, setProviderId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [config, setConfig] = useState("{}");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = useMemo(
    () => providers.find((provider) => provider.id === providerId),
    [providerId, providers],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    let publicConfig: Record<string, unknown>;
    try {
      publicConfig = JSON.parse(config) as Record<string, unknown>;
      if (!publicConfig || Array.isArray(publicConfig)) throw new Error();
    } catch {
      setError("Public configuration must be a JSON object.");
      return;
    }
    setSaving(true);
    try {
      const connection = await createConnection({
        providerId,
        displayName,
        publicConfig,
      });
      onCreated(connection);
      setDisplayName("");
      setConfig("{}");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not add connection.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Add a connection</h2>
          <p>
            Only non-secret coordinates belong here. Authentication stays in the
            provider.
          </p>
        </div>
      </div>
      <form
        className="panel__body connections-form"
        onSubmit={(event) => void submit(event)}
      >
        <div className="field">
          <label htmlFor="connection-provider">Provider</label>
          <select
            id="connection-provider"
            value={providerId}
            onChange={(event) => setProviderId(event.target.value)}
            required
          >
            <option value="">Choose a provider</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="connection-name">Display name</label>
          <input
            id="connection-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={120}
            required
          />
        </div>
        <div className="field connections-form__config">
          <label htmlFor="connection-config">Public configuration (JSON)</label>
          <textarea
            id="connection-config"
            value={config}
            onChange={(event) => setConfig(event.target.value)}
            spellCheck={false}
          />
          <span className="hint">
            Examples: region, vault name, mount, project, or endpoint.
            Secret-like fields are rejected by the Host.
          </span>
        </div>
        {selected ? (
          <p className="hint connections-form__detail">
            Adapter <code>{selected.adapter}</code> ·{" "}
            {selected.capabilities.join(", ")} ·{" "}
            {selected.support.replace("_", " ")}
          </p>
        ) : null}
        {error ? (
          <p className="note note--err connections-form__detail">{error}</p>
        ) : null}
        <div className="actions connections-form__detail">
          <button type="submit" className="btn btn--primary" disabled={saving}>
            <IconPlus size={16} /> {saving ? "Adding…" : "Add connection"}
          </button>
        </div>
      </form>
    </section>
  );
}

function ConnectionRow({
  connection,
  provider,
  onRemoved,
  setNotice,
}: {
  connection: Connection;
  provider?: Provider;
  onRemoved: () => void;
  setNotice: (notice: Notice) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function probe() {
    setBusy(true);
    try {
      const result = await testProvider(connection.providerId);
      const detail =
        typeof result.detail === "string"
          ? result.detail
          : JSON.stringify(result.detail);
      setNotice({
        tone: result.available ? "ok" : "err",
        text: `${provider?.displayName ?? connection.providerId}: ${detail}`,
      });
    } catch (error) {
      setNotice({
        tone: "err",
        text: error instanceof Error ? error.message : "Probe failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove ${connection.displayName}?`)) return;
    setBusy(true);
    try {
      await removeConnection(connection.id);
      onRemoved();
      setNotice({ tone: "ok", text: `${connection.displayName} was removed.` });
    } catch (error) {
      setNotice({
        tone: "err",
        text: error instanceof Error ? error.message : "Remove failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="connections-row">
      <div>
        <h3>{connection.displayName}</h3>
        <p>
          <code>{connection.providerId}</code> ·{" "}
          {provider?.categories.join(", ")}
        </p>
      </div>
      <span
        className={`chip${provider?.support === "supported" ? " chip--ok" : " chip--warn"}`}
      >
        {provider?.support.replace("_", " ") ?? "unknown"}
      </span>
      <div className="actions">
        <button
          type="button"
          className="btn btn--sm"
          disabled={busy}
          onClick={() => void probe()}
        >
          Test
        </button>
        <button
          type="button"
          className="btn btn--sm btn--danger"
          disabled={busy}
          onClick={() => void remove()}
        >
          <IconTrash size={15} /> Remove
        </button>
      </div>
    </li>
  );
}
