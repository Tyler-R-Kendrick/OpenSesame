import { useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  IconAlert,
  IconCheck,
  IconChevronLeft,
  IconConnection,
  IconExternal,
  IconX,
} from "../../components/Icons.js";
import { PagesCannotHostNote } from "../../components/PagesCannotHostNote.js";
import type { Connection, Provider } from "../../lib/connections.js";
import { deleteCustomProvider } from "../../lib/connections.js";
import { canConfigureAutomatically } from "../../lib/connector-guidance.js";
import {
  VERB_CHIP,
  VERB_LABEL,
  connectionVerb,
  providerVerb,
} from "../../lib/identity-graph.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { BindingEditor } from "./BindingEditor.js";
import { authKindLabel } from "./CatalogPanel.js";
import { ConnectForm } from "./ConnectForm.js";
import { AutomaticService } from "./ConnectedPanel.js";
import { ConnectionCard } from "./ConnectionCard.js";
import { ConnectorMark } from "./ConnectorMark.js";
import { IdentitySessionNote } from "./IdentitySessionNote.js";
import { PolicyEditor } from "./PolicyEditor.js";
import { VaultReminderBanner } from "./VaultReminderBanner.js";
import { DeploymentSetupGuide } from "./guides.js";
import {
  CATEGORY_LABELS,
  type Flash,
  STATUS_CHIP,
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
  const backRef = useGuideTarget<HTMLAnchorElement>("connections.back");
  const authorizeRef = useGuideTarget<HTMLElement>("connections.authorize");
  const bindingsRef = useGuideTarget<HTMLElement>("connections.bindings");
  if (!provider) {
    return (
      <div className="section__inner">
        <Link ref={backRef} className="conn-back" to="/connections">
          <IconChevronLeft size={16} /> Connections
        </Link>
        <div className="panel">
          <div className="empty">
            <IconConnection />
            <h1>
              {loading ? "Loading connector settings…" : "Connector not found"}
            </h1>
            <p>
              {loading
                ? "Reading this connector from the Host."
                : `No connector named ${providerId} is in the active catalog.`}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const automatic = canConfigureAutomatically(provider);
  return (
    <div className="section__inner conn-settings">
      <Link ref={backRef} className="conn-back" to="/connections">
        <IconChevronLeft size={16} /> Connections
      </Link>
      <PagesCannotHostNote ceremony="Host authorization" />
      <IdentitySessionNote />
      <header className="conn-settings__head">
        <ConnectorMark
          providerId={provider.id}
          displayName={provider.displayName}
          size={44}
        />
        <div className="conn-settings__title">
          <div className="conn-settings__name">
            <h1>{provider.displayName}</h1>
            <span
              className={`chip ${
                VERB_CHIP[
                  connections.length > 1 && !connection
                    ? "idle"
                    : providerVerb(provider, connection)
                ]
              }`}
              aria-label={`Connector status: ${
                connection
                  ? VERB_LABEL[connectionVerb(connection.status)]
                  : connections.length > 1
                    ? `${connections.length} authorizations`
                    : VERB_LABEL[providerVerb(provider, null)]
              }`}
            >
              {connection
                ? VERB_LABEL[connectionVerb(connection.status)]
                : connections.length > 1
                  ? `${connections.length} authorizations`
                  : VERB_LABEL[providerVerb(provider, null)]}
            </span>
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
        {provider.category === "custom" ? (
          <DeleteCustomConnector provider={provider} onFlash={onFlash} />
        ) : null}
      </header>

      {flash ? (
        <output className={`note note--${flash.tone} conn-flash`}>
          {flash.tone === "ok" ? <IconCheck /> : <IconAlert />}
          <p>{flash.text}</p>
          <button
            type="button"
            className="icon-btn"
            onClick={() => onFlash(null)}
            aria-label="Dismiss"
          >
            <IconX />
          </button>
        </output>
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
              <p>No account sign-in or additional configuration is required.</p>
            </div>
          </div>
          <ul className="conn-list">
            <AutomaticService
              provider={provider}
              connection={connection}
              online={online}
              onFlash={(next) => onFlash(next)}
              onChanged={onChanged}
              onRememberOffer={(offer) => onRememberOffer(offer)}
              settings={false}
            />
          </ul>
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
              showBindings={false}
            />
          </ul>
        </section>
      ) : connections.length > 1 ? (
        <section className="panel" id="authorization" ref={authorizeRef}>
          <div className="panel__head">
            <div>
              <h2>Authorizations</h2>
              <p>Choose the account whose access and rules you want to edit.</p>
            </div>
          </div>
          <ul className="conn-list">
            {connections.map((item) => (
              <AuthorizedAccount
                key={item.connectionId}
                connection={item}
                provider={provider}
              />
            ))}
          </ul>
          {canConfigure && provider.configured ? (
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
      ) : (
        <section className="panel" id="authorization" ref={authorizeRef}>
          <div className="panel__head">
            <h2>Connect</h2>
          </div>
          {!canConfigure ? (
            <div className="panel__body">
              <p className="hint">{configureHint}</p>
            </div>
          ) : provider.configured ||
            provider.authKind === "oauth2_authorization_code" ? (
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
              <DeploymentSetupGuide provider={provider} />
            </div>
          )}
        </section>
      )}

      {connection ? (
        <>
          <section className="panel" id="access" ref={bindingsRef}>
            <div className="panel__head">
              <div>
                <h2>Who can use it</h2>
                <p>
                  Assign this authorization to identities, groups, devices,
                  projects, or agents.
                </p>
              </div>
            </div>
            <div className="panel__body">
              <BindingEditor
                connection={connection}
                online={online}
                onFlash={(next) => onFlash(next)}
                onChanged={onChanged}
              />
            </div>
          </section>
          <section className="panel" id="rules">
            <div className="panel__head">
              <div>
                <h2>Rules</h2>
                <p>
                  Set how broadly this authorization may be delegated and
                  invoked.
                </p>
              </div>
            </div>
            <div className="panel__body">
              <PolicyEditor
                connection={connection}
                online={online}
                onFlash={(next) => onFlash(next)}
                onChanged={onChanged}
              />
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

function AuthorizedAccount({
  connection,
  provider,
}: {
  connection: Connection;
  provider: Provider | null;
}) {
  const chip = STATUS_CHIP[connection.status];
  return (
    <li className="conn-service">
      <div className="conn-service__copy">
        <h3>{connection.displayName}</h3>
        <p>{statusSentence(connection, provider)}</p>
      </div>
      <div className="conn-service__actions">
        <span className={`chip ${chip.tone}`}>{chip.label}</span>
        <Link
          className="btn btn--sm"
          to={`/connections/${encodeURIComponent(connection.providerId)}/${encodeURIComponent(connection.connectionId)}`}
          aria-label={`Settings for ${connection.displayName}`}
        >
          Open
        </Link>
      </div>
    </li>
  );
}

function DeleteCustomConnector({
  provider,
  onFlash,
}: {
  provider: Provider;
  onFlash: (flash: Flash | null) => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    try {
      await deleteCustomProvider(provider.id);
      navigate("/connections");
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className="btn btn--sm btn--danger"
      disabled={busy}
      onClick={() => void remove()}
    >
      {busy ? "Deleting…" : "Delete connector"}
    </button>
  );
}
