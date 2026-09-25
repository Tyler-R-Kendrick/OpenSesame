import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { listIntegrations } from "@opensesame/app-core/lib/connections.js";
import { canConfigureAutomatically } from "@opensesame/app-core/lib/connector-guidance.js";
import { isGitBackupProvider } from "@opensesame/app-core/lib/git-backup-forges.js";
import {
  readLocalGithubApp,
  subscribeLocalGithubApp,
} from "@opensesame/app-core/lib/github-app-manifest.js";
import {
  VERB_CHIP,
  VERB_LABEL,
  connectionVerb,
  providerVerb,
} from "@opensesame/app-core/lib/identity-graph.js";
import {
  CATEGORY_LABELS,
  type Flash,
  STATUS_CHIP,
  connectorCeremonyRoot,
  connectorPath,
  errorText,
  statusSentence,
} from "@opensesame/app-core/sections/connections/shared.js";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Link, useLocation } from "react-router";
import {
  IconChevronLeft,
  IconConnection,
  IconExternal,
} from "../../components/Icons.js";
import {
  StatusMark,
  type StatusTone,
  statusTone,
} from "../../components/StatusMark.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { AwsKmsConnectPanel } from "./AwsKmsConnectPanel.js";
import { AzureKeyVaultKeysConnectPanel } from "./AzureKeyVaultKeysConnectPanel.js";
import { BackupEnableSwitch, canBackupEnable } from "./BackupEnableSwitch.js";
import { BackupSyncControls } from "./BackupSyncControls.js";
import { authKindLabel } from "./CatalogPanel.js";
import { ConnectForm } from "./ConnectForm.js";
import { ConnectionCard } from "./ConnectionCard.js";
import { ConnectorMark } from "./ConnectorMark.js";
import { GcpKmsConnectPanel } from "./GcpKmsConnectPanel.js";
import { GithubAppForgetButton } from "./GithubAppConfigRows.js";
import { GithubAppPresence } from "./GithubAppPresence.js";
import {
  AuthorizedAccount,
  githubConnectorStatus,
} from "./SettingsPageStatus.js";
import { VaultReminderBanner } from "./VaultReminderBanner.js";
import { YubikeyConnectPanel } from "./YubikeyConnectPanel.js";
import { ConnectPanels } from "./connect/ConnectPanels.js";

/**
 * Connectors Vercel Connect carries get the plan-built pages (ADR 0146);
 * GitHub keeps its App flow and the Git forges their backup form beside it.
 */
function connectOwned(providerId: string): "only" | "beside" | null {
  if (providerId === "github" || !connectPlan(providerId)) return null;
  return isGitBackupProvider(providerId) ? "beside" : "only";
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
  const [githubHostReady, setGithubHostReady] = useState(false);
  useEffect(() => {
    // A completed local App registration must not leave a failure glyph up.
    if (localGithubApp !== null && flash?.tone === "err") onFlash(null);
  }, [localGithubApp, flash, onFlash]);
  useEffect(() => {
    if (providerId !== "github") {
      setGithubHostReady(false);
      return;
    }
    let cancel = false;
    void listIntegrations()
      .then((rows) => {
        if (cancel) return;
        setGithubHostReady(
          rows.some(
            (row) =>
              row.providerId === "github" && row.enabled && row.configured,
          ),
        );
      })
      .catch(() => {
        if (!cancel) setGithubHostReady(false);
      });
    return () => {
      cancel = true;
    };
  }, [providerId]);
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

  const automatic = canConfigureAutomatically(provider);
  const onConnect = connectOwned(provider.id);
  // GitHub App already on this device — no Connect chrome.
  const githubAppReady =
    provider.id === "github" &&
    (localGithubApp !== null || provider.configured || githubHostReady);
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
              {...githubConnectorStatus(
                provider,
                connection,
                connections,
                backupReady,
                localGithubApp !== null || githubHostReady,
              )}
            />
            {canBackupEnable(provider.id) ? (
              <BackupEnableSwitch
                providerId={provider.id}
                displayName={provider.displayName}
              />
            ) : null}
            {provider.id === "github" && localGithubApp !== null ? (
              <GithubAppForgetButton />
            ) : null}
          </div>
          <p>
            {connection
              ? statusSentence(connection, provider)
              : `${authKindLabel(provider)} · ${CATEGORY_LABELS[provider.category]}`}
          </p>
        </div>
        <a
          className="btn btn--sm btn--ghost"
          href={provider.docsUrl}
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

      {providerId === "github" ? (
        <GithubAppPresence
          connection={connection}
          online={online}
          onFlash={onFlash}
          onReady={reportBackup}
        />
      ) : null}

      {providerId !== "github" && isGitBackupProvider(providerId) ? (
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

      {automatic ? (
        <section className="panel" id="authorization" ref={authorizeRef}>
          <div className="panel__head">
            <div>
              <h2>Authorization</h2>
            </div>
          </div>
          <div className="panel__body">
            <p className="hint">
              {provider.displayName} is built in. Nothing to authorize.
            </p>
          </div>
        </section>
      ) : connection ? (
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
      ) : githubAppReady || onConnect === "only" ? null : (
        <section className="panel" id="authorization" ref={authorizeRef}>
          <div className="panel__head">
            <h2>Connect</h2>
          </div>
          {provider.id === "yubikey" ? (
            <YubikeyConnectPanel onFlash={(next) => onFlash(next)} />
          ) : provider.id === "aws-kms" ? (
            <AwsKmsConnectPanel onFlash={(next) => onFlash(next)} />
          ) : provider.id === "azure-key-vault-keys" ? (
            <AzureKeyVaultKeysConnectPanel onFlash={(next) => onFlash(next)} />
          ) : provider.id === "gcp-kms" ? (
            <GcpKmsConnectPanel onFlash={(next) => onFlash(next)} />
          ) : !canConfigure ? (
            <div className="panel__body">
              <p className="hint">{configureHint}</p>
            </div>
          ) : provider.configured ||
            provider.authKind === "oauth2_authorization_code" ||
            provider.authKind === "configuration" ||
            provider.authKind === "api_key" ||
            isGitBackupProvider(provider.id) ? (
            <ConnectForm
              provider={provider}
              online={online}
              onFlash={(next) => onFlash(next)}
              onConnected={onChanged}
              onRememberOffer={(created) =>
                onRememberOffer({ provider, connection: created })
              }
            />
          ) : (
            <div className="panel__body">
              <p className="hint">
                {provider.displayName} connects over OAuth — pick an OAuth
                connector from the catalog.
              </p>
            </div>
          )}
        </section>
      )}
      {onConnect ? (
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

type ConnectorTitleStatus = { tone: StatusTone; label: string };
