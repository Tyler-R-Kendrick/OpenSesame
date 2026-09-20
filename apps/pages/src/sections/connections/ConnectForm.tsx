import { type FormEvent, useId, useState } from "react";
import { IconCheck, IconInfo } from "../../components/Icons.js";
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
import { usesConnect } from "../../lib/vercel-connect.js";
import { OauthConnectBody } from "./OauthConnectBody.js";
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
      if (!usesConnect(provider.id)) await ensureHostSession();
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
        text:
          provider.id === "github"
            ? "GitHub connected."
            : `${provider.displayName} connected.`,
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
        text: `${provider.displayName} configuration saved.`,
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
            className="icon-btn icon-btn--sm"
            disabled={busy || !online}
            aria-label={busy ? "Saving" : "Save configuration"}
            title={busy ? "Saving" : "Save configuration"}
          >
            <IconCheck size={16} />
          </button>
        </div>
      </form>
    );
  }

  if (provider.authKind === "api_key") {
    return (
      <form className="conn-tile__body" onSubmit={saveKey}>
        <div className="field">
          <label className="label" htmlFor={keyId}>
            API key
          </label>
          <input
            id={keyId}
            type="password"
            autoComplete="off"
            placeholder="Paste API key once"
            title="Paste once. It is not shown again."
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
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
            className="icon-btn icon-btn--sm"
            disabled={busy || !online || apiKey.trim() === ""}
            aria-label={busy ? "Saving" : `Connect ${provider.displayName}`}
            title={busy ? "Saving" : `Connect ${provider.displayName}`}
          >
            <IconCheck size={16} />
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
