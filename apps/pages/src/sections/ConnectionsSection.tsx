import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useParams } from "react-router";
import { usePublishConnections } from "../components/ConnectionsNavigation.js";
import { IconAlert, IconRefresh } from "../components/Icons.js";
import { StatusMark } from "../components/StatusMark.js";
import { mergeLocalGitConnections } from "../lib/connections-local-git.js";
import {
  type Connection,
  ConnectionsError,
  type Provider,
  listConnections,
} from "../lib/connections.js";
import { getBundledProviders } from "../lib/embedded-catalog.js";

import { useOnline } from "../lib/use-online.js";
import { vercelCatalogSeams } from "../lib/vercel-connect-catalog.js";

import { noteGuideConnectionsPresent } from "../tutorial/registry/predicates.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { CatalogPanel } from "./connections/CatalogPanel.js";
import { ConnectedPanel } from "./connections/ConnectedPanel.js";
import { NeedsAttention } from "./connections/NeedsAttention.js";
import { ConnectorSettingsPage } from "./connections/SettingsPage.js";
import { VaultReminderBanner } from "./connections/VaultReminderBanner.js";
import {
  type Flash,
  type LoadFailure,
  errorText,
} from "./connections/shared.js";
import "./connections.css";

import { useIdentitySession } from "../bindings/identity.js";
import { useVercelConnectConfigured } from "../bindings/vercel-connect.js";
export function ConnectionsSection() {
  const { providerId, connectionId } = useParams();
  const { hash, search } = useLocation();
  const online = useOnline();
  // Live connections go through Vercel Connect. The catalog below is
  // embedded and stays browsable with no backend at all (ADR 0090).
  const connectConfigured = useVercelConnectConfigured();
  const liveConnections = connectConfigured;
  const session = useIdentitySession();

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

  // OAuth-callback landing: the relay bounces the popup here after approval.
  // Same origin as the opener, so the message passes the consent listener
  // and the popup closes itself — the poll would settle anyway, this is
  // just faster and tidier.
  useEffect(() => {
    if (!window.opener) return;
    const returned = new URLSearchParams(search).get("connection");
    if (!returned) return;
    window.opener.postMessage(
      { type: "opensesame:connection", connectionId: returned },
      window.location.origin,
    );
    window.close();
  }, [search]);

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
    setProviders(vercelCatalogSeams.providers(getBundledProviders()));
    if (catalogRun.current !== id) return;
    setCatalogError(null);
  }, []);

  const loadConnections = useCallback(async () => {
    const id = ++connectionRun.current;
    setLoading(true);
    try {
      const nextConnections = await listConnections();
      if (connectionRun.current !== id) return;
      setConnections(nextConnections);
      setLoadError(null);
    } catch (error) {
      if (connectionRun.current !== id) return;
      setConnections(mergeLocalGitConnections([]));
      setLoadError({
        message: errorText(error),
        unreachable:
          error instanceof ConnectionsError && error.code === "unreachable",
        setupRequired: false,
      });
    } finally {
      if (connectionRun.current === id) setLoading(false);
    }
  }, []);

  // Re-run after Identity changes because the catalog can differ per session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: session is the retry trigger.
  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog, session, providerId]);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

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
        canConfigure={loadError?.setupRequired !== true}
        configureHint={
          connectConfigured
            ? "Authorize this connector to use it from this device."
            : "This deployment has no Connect relay — set VITE_CONNECT_CALLBACK_BASE to enable OAuth."
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

      {flash ? (
        <StatusMark
          tone={
            flash.tone === "ok" ? "ok" : flash.tone === "warn" ? "warn" : "err"
          }
          label={flash.text}
        />
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
        setupRequired={loadError?.setupRequired === true}
      />

      <CatalogPanel providers={providers} connections={connections ?? []} />
    </div>
  );
}
