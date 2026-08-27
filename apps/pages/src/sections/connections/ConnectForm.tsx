import { type FormEvent, useId, useState } from "react";
import { IconExternal } from "../../components/Icons.js";
import { IconInfo } from "../../components/Icons.js";
import { PasskeyCeremonyNote } from "../../components/PasskeyCeremonyNote.js";
import type { Connection, Provider } from "../../lib/connections.js";
import {
  authorizeConnection,
  awaitConsent,
  createConnection,
  openConsentPopup,
  setConnectionConfiguration,
  setConnectionCredential,
} from "../../lib/connections.js";
import {
  configurationDefaults,
  configurationPayload,
  fieldGuidance,
  needsScopeSelection,
} from "../../lib/connector-guidance.js";
import { ensureHostSession } from "../../lib/identity.js";
import { OauthClientPanel } from "./OauthClientPanel.js";
import { ConnectorSetupGuide } from "./guides.js";
import { type Flash, errorText } from "./shared.js";

export function defaultsFor(provider: Provider) {
  const defaults = new Map<string, string>();
  for (const [key, value] of Object.entries(configurationDefaults(provider))) {
    if (value !== undefined) defaults.set(key, value);
  }
  return Object.fromEntries(defaults);
}

export function ConnectForm({
  provider,
  online,
  onFlash,
  onConnected,
  onRememberOffer,
}: {
  provider: Provider;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onConnected: () => void;
  onRememberOffer?: (connection: Connection) => void;
}) {
  const [name, setName] = useState(provider.displayName);
  const [scopes, setScopes] = useState<string[]>(() =>
    provider.scopes.filter((scope) => scope.default).map((scope) => scope.name),
  );
  const [apiKey, setApiKey] = useState("");
  const [configuration, setConfiguration] = useState<Record<string, string>>(
    () => defaultsFor(provider),
  );
  const [busy, setBusy] = useState(false);
  const nameId = useId();
  const keyId = useId();
  const missingScope = needsScopeSelection(provider, scopes);

  function toggle(scope: string) {
    setScopes((current) =>
      current.includes(scope)
        ? current.filter((value) => value !== scope)
        : [...current, scope],
    );
  }

  async function connectOauth(event: FormEvent) {
    event.preventDefault();
    // Opened synchronously or the browser treats it as an unsolicited popup;
    // the real destination is set once the broker has issued the state.
    const popup = openConsentPopup("about:blank");
    setBusy(true);
    let created = false;
    try {
      await ensureHostSession();
      const connection = await createConnection({
        providerId: provider.id,
        displayName: name.trim() || provider.displayName,
        scopes,
      });
      created = true;
      const { authorizationUrl } = await authorizeConnection(
        connection.connectionId,
        scopes,
      );
      if (popup) popup.location.href = authorizationUrl;
      else window.location.href = authorizationUrl;

      const outcome = await awaitConsent(connection.connectionId, popup);
      if (outcome.result === "active") {
        onFlash({
          tone: "ok",
          text: `${provider.displayName} is connected${
            outcome.connection.accountLabel
              ? ` as ${outcome.connection.accountLabel}`
              : ""
          }. Bind it to a project or agent to let them use it.`,
        });
        onRememberOffer?.(outcome.connection);
        onConnected();
      } else if (outcome.result === "failed") {
        onFlash({
          tone: "err",
          text:
            outcome.connection.statusDetail ??
            `${provider.displayName} refused the authorization.`,
        });
        onConnected();
      } else {
        onFlash({
          tone: "warn",
          text: `Consent for ${provider.displayName} was not completed. The connection is waiting, and you can authorize it above.`,
        });
        onConnected();
      }
    } catch (error) {
      popup?.close();
      onFlash({ tone: "err", text: errorText(error) });
      if (created) onConnected();
    } finally {
      setBusy(false);
    }
  }

  async function saveKey(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    let created = false;
    try {
      const connection = await createConnection({
        providerId: provider.id,
        displayName: name.trim() || provider.displayName,
        scopes: scopes.length > 0 ? scopes : undefined,
      });
      created = true;
      await setConnectionCredential(connection.connectionId, apiKey.trim());
      setApiKey("");
      onFlash({
        tone: "ok",
        text: `${provider.displayName} credential stored on this Host.`,
      });
      onRememberOffer?.(connection);
      onConnected();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
      if (created) onConnected();
    } finally {
      setBusy(false);
    }
  }

  async function saveConfiguration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const form = event.currentTarget;
    const payload = configurationPayload(provider, configuration);
    form.reset();
    setConfiguration(defaultsFor(provider));
    let created = false;
    try {
      const connection = await createConnection({
        providerId: provider.id,
        displayName: name.trim() || provider.displayName,
      });
      created = true;
      await setConnectionConfiguration(connection.connectionId, payload);
      onFlash({
        tone: "ok",
        text: `${provider.displayName} configuration saved on this Host.`,
      });
      onRememberOffer?.(connection);
      onConnected();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
      if (created) onConnected();
    } finally {
      setBusy(false);
    }
  }

  if (provider.authKind === "configuration") {
    const defaults = defaultsFor(provider);
    const fields = provider.configurationFields ?? [];
    const requiredFields = fields.filter(
      (field) => field.required && defaults[field.name] === undefined,
    );
    const optionalFields = fields.filter(
      (field) => !requiredFields.includes(field),
    );
    const renderFields = (configurationFields: typeof fields) =>
      configurationFields.map((field) => {
        const id = `${nameId}-${field.name}`;
        const guidance = fieldGuidance(field);
        const automatic = defaults[field.name];
        return (
          <div className="field" key={field.name}>
            <label className="label conn-field-label" htmlFor={id}>
              {field.label}
              {automatic
                ? " (automatic)"
                : field.required
                  ? " (required)"
                  : " (optional)"}
              <span title={guidance.help} aria-hidden="true">
                <IconInfo size={14} />
              </span>
            </label>
            <input
              id={id}
              name={field.name}
              type={
                field.secret
                  ? "password"
                  : field.name.endsWith("_url")
                    ? "url"
                    : "text"
              }
              autoComplete="off"
              required={field.required}
              placeholder={guidance.placeholder}
              aria-describedby={`${id}-help`}
              title={guidance.help}
              value={configuration[field.name] ?? ""}
              onChange={(event) =>
                setConfiguration((current) => ({
                  ...current,
                  [field.name]: event.target.value,
                }))
              }
            />
            <p className="hint" id={`${id}-help`}>
              {guidance.help}
              {automatic ? " Filled automatically; change it if needed." : ""}
            </p>
          </div>
        );
      });

    return (
      <form className="conn-tile__body" onSubmit={saveConfiguration}>
        <ConnectorSetupGuide provider={provider} />
        {renderFields(requiredFields)}
        <details className="conn-client-alt">
          <summary>Optional settings</summary>
          <div className="field">
            <label className="label" htmlFor={nameId}>
              Name it (optional)
            </label>
            <input
              id={nameId}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <p className="hint">
              Only changes the label in OpenSesame; the provider never sees it.
            </p>
          </div>
          {renderFields(optionalFields)}
        </details>
        <p className="hint">
          Secret fields are sealed on arrival and are never returned to this
          browser.
        </p>
        <div className="actions">
          <button
            type="submit"
            className="btn btn--primary btn--sm"
            disabled={busy || !online}
          >
            {busy ? "Saving…" : "Save configuration"}
          </button>
        </div>
      </form>
    );
  }

  if (provider.authKind === "api_key") {
    return (
      <form className="conn-tile__body" onSubmit={saveKey}>
        <ConnectorSetupGuide provider={provider} />
        <div className="field">
          <label className="label" htmlFor={keyId}>
            API key
          </label>
          <input
            id={keyId}
            type="password"
            autoComplete="off"
            placeholder="Paste API key once"
            aria-describedby={`${keyId}-help`}
            title="Create a restricted API key in the provider console, then paste it here once."
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <p className="hint" id={`${keyId}-help`}>
            Sealed by the authority plane on arrival. It is not shown again
            here, and no agent can read it back.
          </p>
        </div>
        <details className="conn-client-alt">
          <summary>Optional settings</summary>
          <div className="field">
            <label className="label" htmlFor={nameId}>
              Name it (optional)
            </label>
            <input
              id={nameId}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <p className="hint">
              Only changes the label in OpenSesame; the provider never sees it.
            </p>
          </div>
        </details>
        <div className="actions">
          <button
            type="submit"
            className="btn btn--primary btn--sm"
            disabled={busy || !online || apiKey.trim() === ""}
          >
            {busy ? "Saving…" : `Connect ${provider.displayName}`}
          </button>
        </div>
      </form>
    );
  }

  return (
    <OauthConnectBody
      provider={provider}
      online={online}
      busy={busy}
      name={name}
      nameId={nameId}
      keyId={keyId}
      apiKey={apiKey}
      scopes={scopes}
      missingScope={missingScope}
      onName={setName}
      onApiKey={setApiKey}
      onToggleScope={toggle}
      onFlash={onFlash}
      onConnectOauth={connectOauth}
      onSaveKey={saveKey}
    />
  );
}

function OauthConnectBody({
  provider,
  online,
  busy,
  name,
  nameId,
  keyId,
  apiKey,
  scopes,
  missingScope,
  onName,
  onApiKey,
  onToggleScope,
  onFlash,
  onConnectOauth,
  onSaveKey,
}: {
  provider: Provider;
  online: boolean;
  busy: boolean;
  name: string;
  nameId: string;
  keyId: string;
  apiKey: string;
  scopes: string[];
  missingScope: boolean;
  onName: (value: string) => void;
  onApiKey: (value: string) => void;
  onToggleScope: (scope: string) => void;
  onFlash: (flash: Flash) => void;
  onConnectOauth: (event: FormEvent) => Promise<void>;
  onSaveKey: (event: FormEvent) => Promise<void>;
}) {
  const acceptsPat = provider.id === "github" || provider.id === "gitlab";
  const [hasClient, setHasClient] = useState(false);
  // Derived, not latched: the bundled catalog can briefly claim a provider is
  // configured before the Host's answer replaces it.
  const oauthReady = provider.configured || hasClient;

  return (
    <div className="conn-tile__body">
      <OauthClientPanel
        provider={provider}
        online={online}
        onFlash={onFlash}
        onClientState={setHasClient}
      />
      <form onSubmit={(event) => void onConnectOauth(event)}>
        <PasskeyCeremonyNote />
        <ConnectorSetupGuide provider={provider} />
        {!oauthReady && acceptsPat ? (
          <p className="hint">
            Once the OAuth client above exists, Authorize works. A personal
            access token below is an alternative if you already have one.
          </p>
        ) : null}
        <details className="conn-client-alt">
          <summary>Optional settings</summary>
          <div className="field">
            <label className="label" htmlFor={nameId}>
              Name it (optional)
            </label>
            <input
              id={nameId}
              value={name}
              onChange={(event) => onName(event.target.value)}
            />
            <p className="hint">
              How it reads in this list. The provider never sees it.
            </p>
          </div>
        </details>

        {provider.scopes.length > 0 ? (
          <fieldset className="conn-scope-picker">
            <legend className="label">Ask for</legend>
            {provider.scopes.map((scope) => (
              <label className="check" key={scope.name}>
                <input
                  type="checkbox"
                  checked={scopes.includes(scope.name)}
                  onChange={() => onToggleScope(scope.name)}
                />
                <span>
                  <code>{scope.name}</code>
                  {scope.sensitive ? (
                    <span className="chip chip--warn chip--sm">broad</span>
                  ) : null}
                  <span className="hint">{scope.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}

        <div className="actions">
          <button
            type="submit"
            className="btn btn--primary btn--sm"
            disabled={busy || !online || missingScope || !oauthReady}
          >
            <IconExternal size={16} />
            {busy
              ? "Waiting for consent…"
              : `Authorize with ${provider.displayName}`}
          </button>
        </div>
        {missingScope ? (
          <p className="hint">
            Pick at least one scope — an authorization with none can do nothing.
          </p>
        ) : null}
        {!oauthReady ? (
          <p className="hint">
            Set up the OAuth client above first
            {acceptsPat ? ", or use a personal access token below" : ""}.
          </p>
        ) : null}
      </form>

      {acceptsPat ? (
        <form className="cap-pat" onSubmit={(event) => void onSaveKey(event)}>
          <div className="field">
            <label className="label" htmlFor={`${keyId}-pat`}>
              Or connect with a personal access token
            </label>
            <input
              id={`${keyId}-pat`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={
                provider.id === "github"
                  ? "ghp_… or github_pat_… (repo scope)"
                  : "glpat-…"
              }
              value={apiKey}
              onChange={(event) => onApiKey(event.target.value)}
            />
            <p className="hint">
              Sealed on the Host immediately. Never stored in this browser.
            </p>
          </div>
          <div className="actions">
            <button
              type="submit"
              className="btn btn--primary btn--sm"
              disabled={busy || !online || apiKey.trim() === ""}
            >
              {busy ? "Saving…" : `Connect ${provider.displayName} with token`}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
