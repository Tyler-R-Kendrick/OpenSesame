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
import type { Connection, Provider } from "../../lib/connections.js";
import { listIntegrations } from "../../lib/connections.js";
import { canConfigureAutomatically } from "../../lib/connector-guidance.js";
import {
  readLocalGithubApp,
  subscribeLocalGithubApp,
} from "../../lib/github-app-manifest.js";
import {
  VERB_CHIP,
  VERB_LABEL,
  connectionVerb,
  providerVerb,
} from "../../lib/identity-graph.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { authKindLabel } from "./CatalogPanel.js";
import { ConnectForm } from "./ConnectForm.js";
import { ConnectionCard } from "./ConnectionCard.js";
import { ConnectorMark } from "./ConnectorMark.js";
import { GithubAppForgetButton } from "./GithubAppConfigRows.js";
import { GithubAppPresence } from "./GithubAppPresence.js";
import { VaultReminderBanner } from "./VaultReminderBanner.js";
import {
  CATEGORY_LABELS,
  type Flash,
  STATUS_CHIP,
  connectorCeremonyRoot,
  connectorPath,
  errorText,
  statusSentence,
} from "./shared.js";

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
          <GithubAppPresence connection={connection} />
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
  // GitHub App already on this device / Host — no Connect chrome.
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
        <GithubAppPresence connection={connection} />
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
            />
          </ul>
          {canConfigure && provider.id === "git" ? (
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
          (provider.configured || provider.id === "git") &&
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
      ) : githubAppReady ? null : (
        <section className="panel" id="authorization" ref={authorizeRef}>
          <div className="panel__head">
            <h2>Connect</h2>
          </div>
          {!canConfigure ? (
            <div className="panel__body">
              <p className="hint">{configureHint}</p>
            </div>
          ) : provider.configured ||
            provider.authKind === "oauth2_authorization_code" ||
            provider.id === "git" ? (
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
    </div>
  );
}

type ConnectorTitleStatus = { tone: StatusTone; label: string };

function githubConnectorStatus(
  provider: Provider,
  connection: Connection | null,
  connections: Connection[],
  backupReady: boolean,
  localApp: boolean,
): ConnectorTitleStatus {
  if (provider.id === "github") {
    if (connection !== null && !backupReady) {
      return {
        tone: "warn",
        label: "Needs a backup repository",
      } satisfies ConnectorTitleStatus;
    }
    if (connection !== null) {
      return {
        tone: statusTone(VERB_CHIP[connectionVerb(connection.status)]),
        label: VERB_LABEL[connectionVerb(connection.status)],
      } satisfies ConnectorTitleStatus;
    }
    if (localApp || provider.configured) {
      return {
        tone: "ok",
        label: "GitHub App ready",
      } satisfies ConnectorTitleStatus;
    }
  }
  if (connections.length > 1 && !connection) {
    return {
      tone: "idle",
      label: `${connections.length} authorizations`,
    } satisfies ConnectorTitleStatus;
  }
  const verb = providerVerb(provider, connection);
  return {
    tone: statusTone(VERB_CHIP[verb]),
    label: VERB_LABEL[verb],
  } satisfies ConnectorTitleStatus;
}

function AuthorizedAccount({
  connection,
  provider,
  ceremonyRoot,
}: {
  connection: Connection;
  provider: Provider | null;
  ceremonyRoot: ReturnType<typeof connectorCeremonyRoot>;
}) {
  const chip = STATUS_CHIP[connection.status];
  return (
    <li className="conn-service">
      <div className="conn-service__copy">
        <h3>{connection.displayName}</h3>
        <p>{statusSentence(connection, provider)}</p>
      </div>
      <div className="conn-service__actions">
        <StatusMark tone={statusTone(chip.tone)} label={chip.label} />
        <Link
          className="btn btn--sm"
          to={connectorPath(
            connection.providerId,
            connection.connectionId,
            ceremonyRoot,
          )}
          aria-label={`Settings for ${connection.displayName}`}
        >
          Open
        </Link>
      </div>
    </li>
  );
}
