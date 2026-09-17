import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useParams } from "react-router";
import { usePublishConnections } from "../components/ConnectionsNavigation.js";
import {
  IconAlert,
  IconCheck,
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
} from "../lib/connections.js";
import {
  listCustomConnectors,
  mergeCustomConnectors,
} from "../lib/custom-connectors.js";
import { getBundledProviders } from "../lib/embedded-catalog.js";
import {
  HostSessionError,
  hostLocalSessionEligible,
  useConnect,
  useIdentitySession,
} from "../lib/identity.js";
import { shouldAutoConnect } from "../lib/settings.js";
import { useHostConfigured } from "../lib/use-configured.js";
import { useOnline } from "../lib/use-online.js";
import { vercelCatalogSeams } from "../lib/vercel-connect-catalog.js";
import { useVercelConnectConfigured } from "../lib/vercel-connect.js";
import { noteGuideConnectionsPresent } from "../tutorial/registry/predicates.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { CatalogPanel } from "./connections/CatalogPanel.js";
import { ConnectSessionNote } from "./connections/ConnectSessionNote.js";
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
  const { hash } = useLocation();
  const online = useOnline();
  // Live connections go through Vercel Connect. The catalog below is
  // embedded and stays browsable with no backend at all (ADR 0090).
  const hostConfigured = useHostConfigured();
  const connectConfigured = useVercelConnectConfigured();
  const liveConnections = hostConfigured || connectConfigured;
  const session = useIdentitySession();
  const { connecting, error: connectError, connect } = useConnect();

  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  useEffect(() => {
    const ready = hash.startsWith("#connected-")
      ? connections !== null
      : providers !== null;
    if (
      ready &&
      !providerId &&
      /^#(?:attention|connected|catalog)(?:-|$)/.test(hash)
    ) {
      document
        .getElementById(hash === "#catalog-more" ? "catalog" : hash.slice(1))
        ?.scrollIntoView?.({ block: "start" });
    }
  }, [hash, providerId, providers, connections]);
  usePublishConnections(providers, connections);
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
    setProviders(
      mergeCustomConnectors(
        vercelCatalogSeams.providers(getBundledProviders()),
      ),
    );
    if (catalogRun.current !== id) return;
    setCatalogError(null);
  }, []);

  const loadConnections = useCallback(async () => {
    const id = ++connectionRun.current;
    if (!liveConnections) {
      setConnections([]);
      setLoadError(null);
      setLoading(false);
      return;
    }
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
          text: `${configured} connector${configured === 1 ? "" : "s"} already configured ${configured === 1 ? "was" : "were"} connected automatically.`,
        });
      }
    } catch (error) {
      if (connectionRun.current !== id) return;
      setConnections([]);
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
  }, [liveConnections]);

  // Re-run after Identity changes because Host authentication is session-backed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: session is the retry trigger.
  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog, session, providerId]);

  useEffect(() => {
    if (!connectConfigured && !session && !hostLocalSessionEligible()) return;
    void loadConnections();
  }, [session, loadConnections, connectConfigured]);

  useEffect(() => {
    if (!hostConfigured) return;
    if (hostLocalSessionEligible()) return;
    if (session || !online || connecting || connectError) return;
    if (!shouldAutoConnect()) return;
    void connect();
  }, [hostConfigured, session, online, connecting, connectError, connect]);

  if (providerId === "new") {
    return <CustomConnectorPage />;
  }

  if (providerId) {
    const provider =
      providers?.find((item) => item.id === providerId) ??
      listCustomConnectors().find((item) => item.id === providerId) ??
      null;
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
            ? "You can still save a vault login or import one below."
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
      {hostConfigured ? (
        <PagesCannotHostNote ceremony="Host authorization" />
      ) : null}
      {hostConfigured ? <IdentitySessionNote /> : null}
      <ConnectSessionNote />

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
