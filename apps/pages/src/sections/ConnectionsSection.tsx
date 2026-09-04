import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import {
  IconAlert,
  IconCheck,
  IconInfo,
  IconRefresh,
  IconX,
} from "../components/Icons.js";
import { PagesCannotHostNote } from "../components/PagesCannotHostNote.js";
import {
  type Connection,
  ConnectionsError,
  type Provider,
  discoverConnections,
  listConnections,
  listProviders,
} from "../lib/connections.js";
import {
  getBundledProviders,
  readEmbeddedProviders,
  writeEmbeddedProviders,
} from "../lib/embedded-catalog.js";
import {
  HostSessionError,
  hostLocalSessionEligible,
  useConnect,
  useIdentitySession,
} from "../lib/identity.js";
import { shouldAutoConnect } from "../lib/settings.js";
import { useHostConfigured } from "../lib/use-configured.js";
import { useOnline } from "../lib/use-online.js";
import { useStatusNotice } from "../lib/use-status-notice.js";
import { noteGuideConnectionsPresent } from "../tutorial/registry/predicates.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { CatalogPanel } from "./connections/CatalogPanel.js";
import { ConnectedPanel } from "./connections/ConnectedPanel.js";
import { CustomConnectorPage } from "./connections/CustomConnectorPage.js";
import { IdentitySessionNote } from "./connections/IdentitySessionNote.js";
import { NeedsAttention } from "./connections/NeedsAttention.js";
import { ConnectorSettingsPage } from "./connections/SettingsPage.js";
import { VaultReminderBanner } from "./connections/VaultReminderBanner.js";
import {
  type Flash,
  type LoadFailure,
  errorText,
} from "./connections/shared.js";
import "./connections.css";

export function ConnectionsSection() {
  const { providerId, connectionId } = useParams();
  const online = useOnline();
  // Connections are the Host's to hold (ADR 0090). The connector catalog below
  // is embedded in this build and stays browsable with no Host at all.
  const hostConfigured = useHostConfigured();
  const session = useIdentitySession();
  const { connecting, error: connectError, connect } = useConnect();

  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [catalogError, setCatalogError] = useState<LoadFailure | null>(null);
  const [loadError, setLoadError] = useState<LoadFailure | null>(null);
  const [loading, setLoading] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [rememberOffer, setRememberOffer] = useState<{
    provider: Provider;
    connection: Connection;
  } | null>(null);

  const catalogRun = useRef(0);
  const connectionRun = useRef(0);
  const reloadRef = useGuideTarget<HTMLButtonElement>("connections.reload");

  // A coarse count, never a name: `connections.any` is the only thing a guide
  // may learn about what is connected here.
  useEffect(() => {
    noteGuideConnectionsPresent(
      (connections ?? []).some((item) => item.status !== "revoked"),
    );
    return () => noteGuideConnectionsPresent(false);
  }, [connections]);

  const loadCatalog = useCallback(async () => {
    const id = ++catalogRun.current;
    // Never leave the catalog blocked on Turso/OPFS — paint the bundle first.
    setProviders(getBundledProviders());
    const embedded = await readEmbeddedProviders();
    if (catalogRun.current !== id) return;
    setProviders(embedded);
    try {
      const nextProviders = await listProviders();
      if (catalogRun.current !== id) return;
      if (nextProviders.length === 0) {
        // An empty Host catalog must not wipe the built-in list on github.io.
        setCatalogError(null);
        return;
      }
      setProviders(nextProviders);
      setCatalogError(null);
      void writeEmbeddedProviders(nextProviders);
    } catch (error) {
      if (catalogRun.current !== id) return;
      setCatalogError({
        message: errorText(error),
        unreachable:
          error instanceof ConnectionsError && error.code === "unreachable",
      });
    }
  }, []);

  const loadConnections = useCallback(async () => {
    const id = ++connectionRun.current;
    setLoading(true);
    try {
      let configured = 0;
      try {
        configured = await discoverConnections();
      } catch {
        // Discovery is best-effort — never block the connections list on it.
      }
      const nextConnections = await listConnections();
      if (connectionRun.current !== id) return;
      setConnections(nextConnections);
      setLoadError(null);
      if (configured > 0) {
        setFlash({
          tone: "ok",
          text: `${configured} connector${configured === 1 ? "" : "s"} already configured on this Host ${configured === 1 ? "was" : "were"} connected automatically.`,
        });
      }
    } catch (error) {
      if (connectionRun.current !== id) return;
      setConnections(null);
      setLoadError({
        message: errorText(error),
        unreachable:
          error instanceof ConnectionsError && error.code === "unreachable",
        setupRequired:
          error instanceof HostSessionError && error.code !== "invalid_host",
      });
    } finally {
      if (connectionRun.current === id) setLoading(false);
    }
  }, []);

  // Re-run after Identity changes because Host authentication is session-backed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: session is the retry trigger.
  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog, session]);

  useEffect(() => {
    if (!session && !hostLocalSessionEligible()) return;
    void loadConnections();
  }, [session, loadConnections]);

  useEffect(() => {
    if (hostLocalSessionEligible()) return;
    if (session || !online || connecting || connectError) return;
    if (!shouldAutoConnect()) return;
    void connect();
  }, [session, online, connecting, connectError, connect]);

  // Standing load trouble goes to the notifications tray, not the page.
  useStatusNotice(
    loadError && !loadError.setupRequired
      ? {
          id: "connections-load",
          tone: "err",
          title: loadError.unreachable
            ? "Host API unavailable"
            : "Connections could not load",
          body: `${loadError.message} ${
            loadError.unreachable
              ? "Start the configured Host service, or repair it here."
              : "Try refreshing the connection list."
          }`,
          ...(loadError.unreachable
            ? {
                ceremony: "host" as const,
                ceremonyLabel: "Repair the Host connection",
              }
            : null),
          retry: loadConnections,
          retryLabel: "Reload",
        }
      : null,
  );
  useStatusNotice(
    catalogError && (providers?.length ?? 0) > 0
      ? {
          id: "catalog-stale",
          tone: "warn",
          title: "Host catalog did not refresh",
          body: "Showing the bundled connectors instead.",
          retry: loadCatalog,
          retryLabel: "Try again",
        }
      : null,
  );

  if (providerId === "new") {
    return <CustomConnectorPage />;
  }

  if (providerId) {
    const provider = providers?.find((item) => item.id === providerId) ?? null;
    const providerConnections = (connections ?? []).filter(
      (item) => item.providerId === providerId && item.status !== "revoked",
    );
    const connection = connectionId
      ? (providerConnections.find(
          (item) => item.connectionId === connectionId,
        ) ?? null)
      : providerConnections.length === 1
        ? (providerConnections[0] ?? null)
        : null;
    return (
      <ConnectorSettingsPage
        provider={provider}
        providerId={providerId}
        connection={connection}
        connections={providerConnections}
        loading={
          providers === null || (session !== null && connections === null)
        }
        online={online}
        canConfigure={
          (session !== null || hostLocalSessionEligible()) &&
          loadError?.setupRequired !== true
        }
        configureHint={
          session === null
            ? "Host authorization waits on an Identity session. You can still save a vault login or import one below."
            : "Select an organization before configuring this connector."
        }
        flash={flash}
        rememberOffer={rememberOffer}
        onFlash={setFlash}
        onRememberOffer={setRememberOffer}
        onChanged={() => void loadConnections()}
      />
    );
  }

  return (
    <div className="section__inner">
      <header className="section__head conn-head">
        <div className="conn-head__titlerow">
          <h1>Connections</h1>
          <button
            ref={reloadRef}
            type="button"
            className="icon-btn"
            onClick={() => void loadConnections()}
            disabled={loading || !online}
            title={loading ? "Loading…" : "Reload connections"}
            aria-label="Reload connections"
          >
            <IconRefresh size={16} />
          </button>
        </div>
      </header>
      <PagesCannotHostNote ceremony="Host authorization" />
      <IdentitySessionNote />

      {flash ? (
        <output className={`note note--${flash.tone} conn-flash`}>
          {flash.tone === "ok" ? <IconCheck /> : <IconAlert />}
          <p>{flash.text}</p>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setFlash(null)}
            aria-label="Dismiss"
          >
            <IconX />
          </button>
        </output>
      ) : null}

      {online ? null : (
        <p className="note note--warn">
          <IconAlert /> This browser is offline. Nothing on this page can be
          read or changed until it reconnects.
        </p>
      )}

      {catalogError && (providers?.length ?? 0) === 0 ? (
        <div className="note note--err conn-error" role="alert">
          <IconAlert />
          <div className="conn-error__copy">
            <strong>Built-in connector catalog unavailable</strong>
            <p>{catalogError.message}</p>
            <button type="button" className="btn btn--sm" onClick={loadCatalog}>
              Try catalog again
            </button>
          </div>
        </div>
      ) : null}

      <NeedsAttention
        connections={connections ?? []}
        providers={providers ?? []}
        onFlash={setFlash}
        onChanged={() => void loadConnections()}
      />

      {rememberOffer ? (
        <VaultReminderBanner
          offer={rememberOffer}
          onFlash={setFlash}
          onDismiss={() => setRememberOffer(null)}
        />
      ) : null}

      <ConnectedPanel
        connections={connections}
        providers={providers ?? []}
        loading={loading}
        online={online}
        onFlash={setFlash}
        onChanged={() => void loadConnections()}
        onRememberOffer={setRememberOffer}
        setupRequired={loadError?.setupRequired === true}
        hostConfigured={hostConfigured}
      />

      <CatalogPanel providers={providers} connections={connections ?? []} />
    </div>
  );
}
