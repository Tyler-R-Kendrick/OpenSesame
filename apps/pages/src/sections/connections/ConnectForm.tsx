import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import {
  authorizeConnection,
  awaitConsent,
  createConnection,
  openConsentPopup,
  setConnectionConfiguration,
  setConnectionCredential,
} from "@opensesame/app-core/lib/connections.js";
import {
  configurationPayload,
  needsScopeSelection,
} from "@opensesame/app-core/lib/connector-guidance.js";
import { isGitBackupProvider } from "@opensesame/app-core/lib/git-backup-forges.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { type FormEvent, useId, useState } from "react";
import { useConnectorRoads } from "../../bindings/connector-roads.js";
import { ApiKeyForm } from "./ApiKeyForm.js";
import { ConfigurationForm } from "./ConfigurationForm.js";
import { GitConnectForm } from "./GitConnectForm.js";
import { OauthConnectBody } from "./OauthConnectBody.js";
import { defaultsFor } from "./connect-defaults.js";
import { useConnectSave } from "./useConnectSave.js";

/**
 * A connector's own form. A git remote is sealed on this device and GitHub's
 * App is registered from the browser; a key or a configuration seals on this
 * device; authorizing runs on Connect. A form whose road is not open
 * (`formRoad`) is not drawn — a key that could only fail is not offered
 * (ADR 0158). What a person types stays until the save has worked; a failure
 * is said beside the key and in the bell.
 */
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
  const [authorizing, setAuthorizing] = useState(false);
  const nameId = useId();
  const sealing = useConnectSave(provider, {
    onFlash,
    onConnected,
    onRememberOffer,
  });
  const road = useConnectorRoads().form(provider);
  const busy = sealing.busy || authorizing;
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
    setAuthorizing(true);
    let created = false;
    try {
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
      setAuthorizing(false);
    }
  }

  async function saveKey(event: FormEvent) {
    event.preventDefault();
    const saved = await sealing.save(
      { name, scopes: scopes.length > 0 ? scopes : undefined },
      async (connection) => {
        await setConnectionCredential(connection.connectionId, apiKey.trim());
        const payload = configurationPayload(provider, configuration);
        if (Object.keys(payload).length > 0) {
          await setConnectionConfiguration(connection.connectionId, payload);
        }
      },
      provider.id === "github"
        ? "GitHub connected."
        : `${provider.displayName} connected.`,
    );
    if (saved) setApiKey("");
  }

  async function saveConfiguration(event: FormEvent) {
    event.preventDefault();
    const payload = configurationPayload(provider, configuration);
    const saved = await sealing.save(
      { name },
      async (connection) => {
        await setConnectionConfiguration(connection.connectionId, payload);
      },
      `${provider.displayName} configuration saved.`,
    );
    if (saved) setConfiguration(defaultsFor(provider));
  }

  if (isGitBackupProvider(provider.id)) {
    return (
      <GitConnectForm
        provider={provider}
        online={online}
        onFlash={onFlash}
        onConnected={onConnected}
        onRememberOffer={onRememberOffer}
      />
    );
  }

  if (provider.authKind === "configuration") {
    return road === null ? null : (
      <ConfigurationForm
        provider={provider}
        name={name}
        values={configuration}
        busy={busy}
        online={online}
        failure={sealing.failure}
        onName={setName}
        onValue={(field, value) =>
          setConfiguration((current) => ({ ...current, [field]: value }))
        }
        onSubmit={(event) => void saveConfiguration(event)}
      />
    );
  }

  if (provider.authKind === "api_key") {
    return road === null ? null : (
      <ApiKeyForm
        provider={provider}
        name={name}
        apiKey={apiKey}
        values={configuration}
        busy={busy}
        online={online}
        failure={sealing.failure}
        onName={setName}
        onApiKey={setApiKey}
        onValue={(field, value) =>
          setConfiguration((current) => ({ ...current, [field]: value }))
        }
        onSubmit={(event) => void saveKey(event)}
      />
    );
  }

  return (
    <OauthConnectBody
      provider={provider}
      online={online}
      busy={busy}
      road={road}
      name={name}
      nameId={nameId}
      scopes={scopes}
      missingScope={missingScope}
      onName={setName}
      onToggleScope={toggle}
      onFlash={onFlash}
      onConnectOauth={connectOauth}
    />
  );
}
