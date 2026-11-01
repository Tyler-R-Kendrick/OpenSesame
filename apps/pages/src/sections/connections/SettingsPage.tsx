import { isAiConnectionProvider } from "@opensesame/app-core/lib/ai-connections/presets.js";
import { connectFormDraws } from "@opensesame/app-core/lib/connect-roads.js";
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { canonicalProviderId } from "@opensesame/app-core/lib/connector-catalog.js";
import { canConfigureAutomatically } from "@opensesame/app-core/lib/connector-guidance.js";
import { docLink } from "@opensesame/app-core/lib/doc-link.js";
import { isGitBackupProvider } from "@opensesame/app-core/lib/git-backup-forges.js";
import {
  readLocalGithubApp,
  subscribeLocalGithubApp,
} from "@opensesame/app-core/lib/github-app-manifest.js";
import {
  isSecretBackendProvider,
  secretBackendPreset,
} from "@opensesame/app-core/lib/secret-backends/presets.js";
import { isSelfHostedConnector } from "@opensesame/app-core/lib/self-hosted-connectors.js";
import {
  hasConnectRoute,
  isVercelCatalogId,
} from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import {
  CATEGORY_LABELS,
  type Flash,
  connectorCeremonyRoot,
  statusSentence,
} from "@opensesame/app-core/sections/connections/shared.js";
import { connectorPath } from "@opensesame/app-core/sections/connections/shared.js";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useConnectorRoads } from "../../bindings/connector-roads.js";
import {
  IconChevronLeft,
  IconConnection,
  IconExternal,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { BackupEnableSwitch, canBackupEnable } from "./BackupEnableSwitch.js";
import { BackupSyncControls } from "./BackupSyncControls.js";
import { authKindLabel } from "./CatalogPanel.js";
import { ConnectForm } from "./ConnectForm.js";
import { ConnectSection } from "./ConnectSection.js";
import { ConnectionCard } from "./ConnectionCard.js";
import { ConnectorMark } from "./ConnectorMark.js";
import { GithubAppForgetButton } from "./GithubAppConfigRows.js";
import { GithubAppPresence } from "./GithubAppPresence.js";
import * as SettingsPanels from "./SettingsPageConnectPanels.js";
import {
  AuthorizedAccount,
  githubConnectorStatus,
} from "./SettingsPageStatus.js";
import { VaultReminderBanner } from "./VaultReminderBanner.js";
import { apiFamilyFor, apiFamilyOptions } from "./catalog-families.js";
import { isConnectConnection } from "./connect/ConnectPanels.js";
import { isIdentityConnectionProvider } from "./identity/IdentityConnectionPanels.js";
import { useTailscaleHeaderStatus } from "./tailscale/useTailscaleConnectionState.js";

/**
 * Registry services get the provider configuration experience. Existing
 * device key/configuration and forge flows keep their working local road;
 * imported hosted connections retain their management panels. GitHub keeps
 * its App flow. A refused service (ADR 0086 §6) gets no Connect road.
 */
const bespokePanel = (id: string): boolean =>
  isAiConnectionProvider(id) || id === "tailscale" || id === "boat";

function connectOwned(providerId: string): "only" | "beside" | null {
  if (!hasConnectRoute(providerId)) return null;
  if (!isVercelCatalogId(providerId) || isGitBackupProvider(providerId))
    return "beside";
  return "only";
}

/** One connector's page: authorize it, then decide who can use it and how. */
export function ConnectorSettingsPage({
  provider,
  providers,
  providerId,
  connection,
  connections,
  loading,
  online,
  canConfigure,
  configureHint,
  flash,
  rememberOffer,
  onFlash,
  onRememberOffer,
  onChanged,
}: {
  provider: Provider | null;
  providers?: readonly Provider[];
  providerId: string;
  connection: Connection | null;
  connections: Connection[];
  loading: boolean;
  online: boolean;
  canConfigure: boolean;
  configureHint: string;
  flash: Flash | null;
  rememberOffer: { provider: Provider; connection: Connection } | null;
  onFlash: (flash: Flash | null) => void;
  onRememberOffer: (
    offer: { provider: Provider; connection: Connection } | null,
  ) => void;
  onChanged: () => void;
}) {
  const liveHeader = useTailscaleHeaderStatus(connection, provider);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const family = provider === null ? undefined : apiFamilyFor(provider.id);
  const familyOptions = apiFamilyOptions(providers ?? [], family);
  const ceremonyRoot = connectorCeremonyRoot(pathname);
  const backRef = useGuideTarget<HTMLAnchorElement>("connections.back");
  const authorizeRef = useGuideTarget<HTMLElement>("connections.authorize");
  const [backupReady, setBackupReady] = useState(false);
  const reportBackup = useCallback((ready: boolean) => {
    setBackupReady(ready);
  }, []);
  const localGithubApp = useSyncExternalStore(
    subscribeLocalGithubApp,
    () => (providerId === "github" ? readLocalGithubApp() : null),
    () => null,
  );
  const roads = useConnectorRoads();
  const identityExperience =
    provider !== null &&
    isIdentityConnectionProvider(provider.id) &&
    !isConnectConnection(connection);
  const secretBackendExperience =
    provider !== null &&
    isSecretBackendProvider(provider.id) &&
    !isConnectConnection(connection);
  const nativeDescriptor =
    provider && !identityExperience && !secretBackendExperience
      ? SettingsPanels.nativeSettingsPageDescriptor(provider, connection)
      : null;
  const nativeExperience =
    nativeDescriptor !== null && !isConnectConnection(connection);
  const headerDocs = provider
    ? docLink(
        provider.displayName,
        nativeExperience
          ? provider.id === "github"
            ? "https://docs.github.com/en/apps"
            : (nativeDescriptor.docsUrl ?? provider.docsUrl)
          : (secretBackendPreset(provider.id)?.docsUrl ?? provider.docsUrl),
      )
    : null;
  useEffect(() => {
    // A completed local App registration must not leave a failure glyph up.
    if (!nativeExperience && localGithubApp !== null && flash?.tone === "err")
      onFlash(null);
  }, [nativeExperience, localGithubApp, flash, onFlash]);
  if (!provider) {
    return (
      <div className="section__inner">
        <Link ref={backRef} className="conn-back" to={ceremonyRoot}>
          <IconChevronLeft size={16} /> Connections
        </Link>
        {providerId === "github" ? (
          <GithubAppPresence
            connection={connection}
            online={online}
            onFlash={onFlash}
            onReady={reportBackup}
          />
        ) : null}
        <div className="panel">
          <div className="empty">
            <IconConnection />
            <h1>
              {loading ? "Loading connector settings…" : "Connector not found"}
            </h1>
          </div>
        </div>
      </div>
    );
  }

  const nativeHeader =
    liveHeader ??
    (nativeExperience
      ? {
          tone: "idle" as const,
          label: nativeDescriptor.methods.some((method) => method.available)
            ? "Not connected"
            : "Not available here",
          sentence: `${provider.id === "github" ? "App or token" : authKindLabel(provider)} · ${CATEGORY_LABELS[provider.category]}`,
        }
      : null);
  const automatic = canConfigureAutomatically(provider);
  const onConnect = connectOwned(provider.id);
  // A key or a configuration is collected on this page, including when
  // Vercel lists the same service.
  const deviceSeal =
    provider.authKind === "api_key" || provider.authKind === "configuration";
  // GitHub App already on this device — no Connect chrome.
  const githubAppReady =
    provider.id === "github" &&
    (localGithubApp !== null || provider.configured);
  return (
    <div className="section__inner conn-settings">
      <Link ref={backRef} className="conn-back" to={ceremonyRoot}>
        <IconChevronLeft size={16} /> Connections
      </Link>
      {family && familyOptions.length > 1 ? (
        <div className="field conn-settings__family">
          <label htmlFor="connector-api-family">{family.name} API</label>
          <select
            id="connector-api-family"
            value={canonicalProviderId(provider.id) ?? provider.id}
            onChange={(event) => navigate(connectorPath(event.target.value))}
          >
            {familyOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <header className="conn-settings__head">
        <ConnectorMark
          providerId={provider.id}
          displayName={provider.displayName}
          size={44}
        />
        <div className="conn-settings__title">
          <div className="conn-settings__name">
            <h1>{provider.displayName}</h1>
            <StatusMark
              {...(nativeHeader ??
                githubConnectorStatus(
                  provider,
                  connection,
                  connections,
                  backupReady,
                  localGithubApp !== null,
                  roads.acts(provider),
                ))}
            />
            {canBackupEnable(provider.id) ? (
              <BackupEnableSwitch
                providerId={provider.id}
                displayName={provider.displayName}
              />
            ) : null}
            {provider.id === "github" &&
            localGithubApp !== null &&
            !nativeExperience ? (
              <GithubAppForgetButton />
            ) : null}
          </div>
          <p>
            {nativeHeader?.sentence ??
              (connection
                ? statusSentence(connection, provider)
                : `${authKindLabel(provider)} · ${CATEGORY_LABELS[provider.category]}`)}
          </p>
        </div>
        {headerDocs ? (
          <a
            className="btn btn--sm btn--ghost"
            href={headerDocs.url}
            target="_blank"
            rel="noreferrer noopener"
            title={headerDocs.label}
          >
            {headerDocs.short} <IconExternal size={14} />
          </a>
        ) : null}
      </header>

      {flash ? (
        <StatusMark
          tone={
            flash.tone === "ok" ? "ok" : flash.tone === "warn" ? "warn" : "err"
          }
          label={flash.text}
        />
      ) : null}

      {providerId === "github" && !nativeExperience ? (
        <GithubAppPresence
          connection={connection}
          online={online}
          onFlash={onFlash}
          onReady={reportBackup}
        />
      ) : null}

      {providerId !== "github" &&
      !nativeExperience &&
      isGitBackupProvider(providerId) ? (
        <section className="panel" data-testid="forge-backup-sync">
          <div className="panel__head">
            <h2>Backup</h2>
          </div>
          <div className="panel__body">
            <BackupSyncControls providerId={providerId} />
          </div>
        </section>
      ) : null}

      {rememberOffer ? (
        <VaultReminderBanner
          offer={rememberOffer}
          onFlash={onFlash}
          onDismiss={() => onRememberOffer(null)}
        />
      ) : null}

      {nativeExperience || identityExperience || secretBackendExperience ||
      (bespokePanel(provider.id) && !isConnectConnection(connection)) ? null : automatic ? (
        <section className="panel" id="authorization" ref={authorizeRef}>
          <div className="panel__head">
            <div>
              <h2>Authorization</h2>
            </div>
          </div>
          <div className="panel__body">
            <p className="hint">Built in.</p>
          </div>
        </section>
      ) : isSelfHostedConnector(connection) ? null : connection ? (
        <section className="panel" id="authorization" ref={authorizeRef}>
          <div className="panel__head">
            <h2>Authorization</h2>
          </div>
          <ul className="conn-list">
            <ConnectionCard
              connection={connection}
              provider={provider}
              online={online}
              onFlash={(next) => onFlash(next)}
              onChanged={onChanged}
              onBackupReady={reportBackup}
              hideRepository={localGithubApp !== null}
            />
          </ul>
          {canConfigure && isGitBackupProvider(provider.id) ? (
            <details className="conn-add-authorization">
              <summary>Add another authorization</summary>
              <ConnectForm
                provider={provider}
                online={online}
                onFlash={(next) => onFlash(next)}
                onConnected={onChanged}
                onRememberOffer={(created) =>
                  onRememberOffer({ provider, connection: created })
                }
              />
            </details>
          ) : null}
        </section>
      ) : connections.length > 1 ? (
        <section className="panel" id="authorization" ref={authorizeRef}>
          <div className="panel__head">
            <div>
              <h2>Authorizations</h2>
            </div>
          </div>
          <ul className="conn-list">
            {connections.map((item) => (
              <AuthorizedAccount
                key={item.connectionId}
                connection={item}
                provider={provider}
                ceremonyRoot={ceremonyRoot}
              />
            ))}
          </ul>
          {canConfigure &&
          (provider.configured || isGitBackupProvider(provider.id)) &&
          connectFormDraws(provider) &&
          !githubAppReady ? (
            <details className="conn-add-authorization">
              <summary>Add another authorization</summary>
              <ConnectForm
                provider={provider}
                online={online}
                onFlash={(next) => onFlash(next)}
                onConnected={onChanged}
                onRememberOffer={(created) =>
                  onRememberOffer({ provider, connection: created })
                }
              />
            </details>
          ) : null}
        </section>
      ) : githubAppReady || (onConnect === "only" && !deviceSeal) ? null : (
        <ConnectSection
          provider={provider}
          online={online}
          canConfigure={canConfigure}
          configureHint={configureHint}
          authorizeRef={authorizeRef}
          onFlash={(next) => onFlash(next)}
          onChanged={onChanged}
          onRememberOffer={(created) =>
            onRememberOffer({ provider, connection: created })
          }
        />
      )}
      <SettingsPanels.SettingsPageConnectPanels
        provider={provider}
        connection={connection}
        online={online}
        onFlash={onFlash}
        onChanged={onChanged}
        identityExperience={identityExperience}
        secretBackendExperience={secretBackendExperience}
        nativeExperience={nativeExperience}
        onConnect={onConnect}
        deviceSeal={deviceSeal}
      />
    </div>
  );
}
