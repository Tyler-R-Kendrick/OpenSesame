import type { DraftState } from "@opensesame/app-core/lib/connect-draft.js";
import type { ConnectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import {
  linearClientId,
  linearRedirectUri,
} from "@opensesame/app-core/lib/linear-connectors.js";
import { selfHostedConfig } from "@opensesame/app-core/lib/self-hosted-config.js";
import type { SelfHostedConnectorOptions } from "@opensesame/app-core/lib/self-hosted-connectors.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { ConfigSelections } from "./ConfigSelections.js";
import { ConnectorIconField } from "./ConnectorIconField.js";
import { ConnectorModes } from "./ConnectorModes.js";
import { CopyKey, OutLink } from "./fields.js";

type Props = {
  plan: ConnectPlan;
  state: DraftState;
  options: SelfHostedConnectorOptions;
  onState: (next: DraftState) => void;
  onOptions: (next: SelfHostedConnectorOptions) => void;
  onIconBusyChange: (busy: boolean) => void;
  onError: (text: string) => void;
};

function LinearModes({ state, options, onState, onOptions }: Props) {
  const managedClientId = linearClientId();
  return (
    <ConnectorModes
      label="Configuration mode"
      legendHidden
      value={options.mode}
      options={[
        { id: "managed", label: "Managed" },
        { id: "byo", label: "Bring Your Own" },
      ]}
      onChange={(mode) => {
        onOptions({ ...options, mode });
        if (mode === "managed")
          onState({
            ...state,
            method: "oauth",
            oauth: {
              ...state.oauth,
              clientId: managedClientId || state.oauth.clientId,
            },
          });
      }}
    />
  );
}

function LinearMethods({ state, options, onState }: Props) {
  if (options.mode !== "byo") return null;
  return (
    <ConnectorModes
      label="Connection method"
      value={state.method as "oauth" | "api-key"}
      options={[
        { id: "oauth", label: "OAuth" },
        { id: "api-key", label: "API key" },
      ]}
      onChange={(method) => onState({ ...state, method })}
    />
  );
}

function LinearAuthentication({
  plan,
  state,
  options,
  onState,
  onOptions,
}: Props) {
  const config = selfHostedConfig(plan);
  const redirectUri = linearRedirectUri();
  const managedClientId = linearClientId();
  return (
    <>
      {state.method === "api-key" ? (
        <>
          <FieldShell
            label="Linear API key"
            type="password"
            value={state.key}
            placeholder="lin_api_…"
            autoComplete="new-password"
            mono
            onValueChange={(key) => onState({ ...state, key })}
          />
          <OutLink href="https://linear.app/settings/account/security">
            Linear API keys
          </OutLink>
        </>
      ) : (
        <>
          <ConfigSelections
            label="App Scopes"
            choices={config?.appScopes ?? []}
            selected={options.appScopes}
            onChange={(appScopes) => onOptions({ ...options, appScopes })}
          />
          <ConfigSelections
            label="User Scopes"
            choices={config?.userScopes ?? []}
            selected={options.userScopes}
            onChange={(userScopes) => onOptions({ ...options, userScopes })}
          />
          <FieldShell
            label="Linear OAuth client ID"
            value={state.oauth.clientId}
            autoComplete="off"
            readOnly={options.mode === "managed" && !!managedClientId}
            mono
            onValueChange={(clientId) =>
              onState({ ...state, oauth: { ...state.oauth, clientId } })
            }
          />
          <FieldShell
            label="Redirect URI"
            value={redirectUri}
            readOnly
            mono
            tail={<CopyKey value={redirectUri} label="Copy redirect URI" />}
          />
          <OutLink href="https://linear.app/settings/api/applications/new">
            Linear developer console
          </OutLink>
        </>
      )}
    </>
  );
}

function LinearWebhooks({ plan, options, onOptions }: Props) {
  const config = selfHostedConfig(plan);
  return (
    <>
      <label className="check">
        <input
          type="checkbox"
          checked={options.webhookEnabled ?? false}
          title="Linear webhook registration requires application admin scope or an API key with workspace admin permissions."
          onChange={(event) =>
            onOptions({ ...options, webhookEnabled: event.target.checked })
          }
        />
        <span>Register a Linear webhook</span>
      </label>
      {options.webhookEnabled ? (
        <>
          <FieldShell
            label="Webhook delivery URL"
            type="url"
            value={options.webhookUrl ?? ""}
            placeholder="https://your-service.example/webhooks/linear"
            mono
            onValueChange={(webhookUrl) =>
              onOptions({ ...options, webhookUrl })
            }
          />
          <ConfigSelections
            label="Webhook Resource Types"
            choices={config?.webhookResourceTypes ?? []}
            selected={options.webhookResourceTypes}
            onChange={(webhookResourceTypes) =>
              onOptions({ ...options, webhookResourceTypes })
            }
          />
        </>
      ) : null}
    </>
  );
}

export function LinearConnectorFields(props: Props) {
  const { state, options, onState, onOptions, onIconBusyChange, onError } =
    props;
  return (
    <>
      <LinearModes {...props} />
      <FieldShell
        label="Connector Name"
        value={state.name}
        onValueChange={(name) => onState({ ...state, name })}
      />
      <FieldShell
        label="Expected Linear workspace (optional)"
        value={options.workspace}
        placeholder="Workspace name, URL key or ID"
        onValueChange={(workspace) => onOptions({ ...options, workspace })}
      />
      <LinearMethods {...props} />
      <LinearAuthentication {...props} />
      <LinearWebhooks {...props} />
      <ConnectorIconField
        value={options.icon}
        onBusyChange={onIconBusyChange}
        onChange={(icon) => onOptions({ ...options, icon })}
        onError={onError}
      />
    </>
  );
}
