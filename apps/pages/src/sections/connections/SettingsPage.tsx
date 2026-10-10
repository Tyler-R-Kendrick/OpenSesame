import { connectFormDraws } from "@opensesame/app-core/lib/connect-roads.js";
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { canConfigureAutomatically } from "@opensesame/app-core/lib/connector-guidance.js";
import { isGitBackupProvider } from "@opensesame/app-core/lib/git-backup-forges.js";
import {
  readLocalGithubApp,
  subscribeLocalGithubApp,
} from "@opensesame/app-core/lib/github-app-manifest.js";
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
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Link, useLocation } from "react-router";
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
import { nativeConnectorHeaderStatus } from "./SettingsPageNativeStatus.js";
import {
  AuthorizedAccount,
  githubConnectorStatus,
} from "./SettingsPageStatus.js";
import { VaultReminderBanner } from "./VaultReminderBanner.js";
import { ConnectPanels, isConnectConnection } from "./connect/ConnectPanels.js";
import {
  NativeConnectorPanels,
  nativeSettingsDescriptor,
} from "./connect/NativeConnectorPanels.js";

/**
 * Registry services get the provider configuration experience. Existing
 * device key/configuration and forge flows keep their working local road;
 * imported hosted connections retain their management panels. GitHub keeps
 * its App flow. A refused service (ADR 0086 §6) gets no Connect road.
 */
function connectOwned(providerId: string): "only" | "beside" | null {
  if (!hasConnectRoute(providerId)) return null;
  if (!isVercelCatalogId(providerId) || isGitBackupProvider(providerId))
    return "beside";
  return "only";
}

/** One connector's page: authorize it, then decide who can use it and how. */
export function ConnectorSettingsPage({
  provider,
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
  const { pathname } = useLocation();
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
  const nativeDescriptor = provider ? nativeSettingsDescriptor(provider) : null;
  const nativeExperience =
    nativeDescriptor !== null && !isConnectConnection(connection);
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
    nativeConnectorHeaderStatus(connection, provider) ??
    (nativeExperience
      ? {
          tone: "idle" as const,
          label: nativeDescriptor.methods.some((method) => method.available)
            ? "Not connected"
            : "Not available here",
          sentence: `${provider.id === "github" ? "Personal access token" : authKindLabel(provider)} · ${CATEGORY_LABELS[provider.category]}`,
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
        <a
          className="btn btn--sm btn--ghost"
          href={
            nativeExperience
              ? (nativeDescriptor.docsUrl ?? provider.docsUrl)
              : provider.docsUrl
          }
          target="_blank"
          rel="noreferrer noopener"
        >
          Docs <IconExternal size={14} />
        </a>
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

      {nativeExperience ? null : automatic ? (
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
      {nativeExperience ? (
        <NativeConnectorPanels
          key={`${provider.id}/${connection?.connectionId ?? "new"}`}
          provider={provider}
          connection={connection}
          onFlash={onFlash}
          onChanged={onChanged}
        />
      ) : onConnect &&
        (!deviceSeal ||
          isSelfHostedConnector(connection) ||
          isConnectConnection(connection)) ? (
        <ConnectPanels
          provider={provider}
          connection={connection}
          online={online}
          onFlash={onFlash}
          onChanged={onChanged}
        />
      ) : null}
    </div>
  );
}
