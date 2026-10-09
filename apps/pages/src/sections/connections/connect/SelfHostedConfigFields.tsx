import {
  type DraftState,
  initialDraftState,
} from "@opensesame/app-core/lib/connect-draft.js";
import type {
  ConnectMethodKind,
  ConnectPlan,
} from "@opensesame/app-core/lib/connect-plan.js";
import { listDeviceConnections } from "@opensesame/app-core/lib/device-connectors.js";
import { selfHostedConfig } from "@opensesame/app-core/lib/self-hosted-config.js";
import {
  type SelfHostedConnectorOptions,
  readSelfHostedConnector,
} from "@opensesame/app-core/lib/self-hosted-connectors.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useId } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { ConfigSelections } from "./ConfigSelections.js";
import { ConnectorIconField } from "./ConnectorIconField.js";
import { MethodFields } from "./MethodFields.js";
import { OauthClientFields, OauthServerFields } from "./OauthFields.js";
import { MethodPicker } from "./fields.js";

type Props = {
  plan: ConnectPlan;
  state: DraftState;
  options: SelfHostedConnectorOptions;
  hasCredential: boolean;
  onState: (next: DraftState) => void;
  onOptions: (next: SelfHostedConnectorOptions) => void;
  onFlash: (flash: Flash) => void;
  onIconBusyChange?: (busy: boolean) => void;
};
export function localState(
  plan: ConnectPlan,
  method?: ConnectMethodKind,
): DraftState {
  const state = initialDraftState(plan, method);
  if (state.method === "managed")
    state.method =
      plan.methods.find((item) => item.kind === "oauth")?.kind ??
      plan.methods.find((item) => item.kind !== "managed")?.kind ??
      "oauth";
  state.keySubject = "app";
  return state;
}

function WorkspaceField({
  plan,
  value,
  onChange,
}: {
  plan: ConnectPlan;
  value: string;
  onChange: (next: string) => void;
}) {
  const id = useId();
  const field = selfHostedConfig(plan)?.fields.find(
    (item) => item.name === "workspace",
  );
  if (!field) return null;
  const names = [
    ...new Set(
      listDeviceConnections()
        .filter((item) => item.providerId === plan.id)
        .map(
          (item) =>
            readSelfHostedConnector(item.connectionId)?.options.workspace,
        )
        .filter(Boolean),
    ),
  ];
  return (
    <div className="f">
      <div className="f__labelrow">
        <label className="f__label" htmlFor={id}>
          Select a {plan.name} workspace
        </label>
      </div>
      <div className="f__shell">
        <input
          id={id}
          className="f__input"
          list={`${id}-workspaces`}
          value={value}
          placeholder={field.placeholder}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      <datalist id={`${id}-workspaces`}>
        {names.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </div>
  );
}

function ConfigurationMode({
  plan,
  state,
  options,
  onState,
  onOptions,
}: Props) {
  const modeName = useId();
  const hasManaged =
    plan.methods.some((method) => method.kind === "managed") &&
    plan.methods.some((method) => method.kind === "oauth");
  return (
    <>
      {hasManaged ? (
        <fieldset className="cx-block">
          <legend className="visually-hidden">Configuration mode</legend>
          <div
            className="cx-modes"
            role="radiogroup"
            aria-label="Configuration mode"
          >
            {(
              [
                ["managed", "Managed"],
                ["byo", "Bring Your Own"],
              ] as const
            ).map(([mode, label]) => (
              <label className="cx-mode" key={mode}>
                <input
                  type="radio"
                  name={modeName}
                  checked={options.mode === mode}
                  onChange={() => {
                    onOptions({ ...options, mode });
                    if (mode === "managed")
                      onState({ ...state, method: "oauth" });
                  }}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
    </>
  );
}
function PermissionFields({ plan, state, options, onState, onOptions }: Props) {
  const config = selfHostedConfig(plan);
  return (
    <>
      {config ? (
        <>
          <ConfigSelections
            label="App Scopes"
            choices={config.appScopes}
            selected={options.appScopes}
            onChange={(appScopes) => {
              onOptions({ ...options, appScopes });
              onState({
                ...state,
                oauth: { ...state.oauth, scopes: appScopes },
              });
            }}
          />
          <ConfigSelections
            label="User Scopes"
            choices={config.userScopes}
            selected={options.userScopes}
            onChange={(userScopes) => onOptions({ ...options, userScopes })}
          />
          <ConfigSelections
            label="Webhook Resource Types"
            choices={config.webhookResourceTypes}
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
function ApplicationFields({
  plan,
  state,
  options,
  hasCredential,
  onState,
}: Props) {
  const localPlan = {
    ...plan,
    methods: plan.methods.filter((method) => method.kind !== "managed"),
  };
  return (
    <>
      {options.mode === "byo" ? (
        <MethodPicker
          plan={localPlan}
          method={state.method}
          onMethod={(method) => onState({ ...state, method })}
        />
      ) : null}
      {state.method === "oauth" ? (
        <>
          <details
            className="cx-application"
            key={options.mode}
            open={options.mode === "byo"}
          >
            <summary>
              {plan.name} OAuth application{" "}
              {hasCredential ? (
                <StatusMark tone="ok" label="Application credential saved" />
              ) : null}
            </summary>
            <div className="cx-form">
              <OauthClientFields plan={plan} state={state} onState={onState} />
            </div>
          </details>
          <details className="cx-application">
            <summary>Advanced OAuth settings</summary>
            <div className="cx-form">
              <OauthServerFields
                plan={plan}
                state={state}
                onState={onState}
                showScopes={false}
              />
            </div>
          </details>
        </>
      ) : (
        <MethodFields plan={localPlan} state={state} onState={onState} local />
      )}
    </>
  );
}
export function SelfHostedConfigFields(props: Props) {
  const { plan, state, options, onState, onOptions, onFlash } = props;
  return (
    <>
      <ConfigurationMode {...props} />
      <WorkspaceField
        plan={plan}
        value={options.workspace}
        onChange={(workspace) => onOptions({ ...options, workspace })}
      />
      <FieldShell
        label="Connector Name"
        value={state.name}
        onValueChange={(name) => onState({ ...state, name })}
      />
      <PermissionFields {...props} />
      <ConnectorIconField
        value={options.icon}
        onBusyChange={props.onIconBusyChange}
        onChange={(icon) => onOptions({ ...options, icon })}
        onError={(text) => onFlash({ tone: "err", text })}
      />
      <ApplicationFields {...props} />
    </>
  );
}
