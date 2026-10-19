import {
  type DraftState,
  initialDraftState,
} from "@opensesame/app-core/lib/connect-draft.js";
import type { ConnectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { kvDurability } from "@opensesame/app-core/lib/kv.js";
import {
  configureLinearConnector,
  linearClientId,
  linearConnectorProblems,
} from "@opensesame/app-core/lib/linear-connectors.js";
import {
  defaultSelections,
  selfHostedConfig,
} from "@opensesame/app-core/lib/self-hosted-config.js";
import {
  type SelfHostedConnectorOptions,
  readSelfHostedConnector,
} from "@opensesame/app-core/lib/self-hosted-connectors.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { type FormEvent, useState } from "react";
import { FormCommit } from "../../../components/FormCommit.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { LinearCancelSignIn } from "./LinearCancelSignIn.js";
import { LinearConnectorFields } from "./LinearConnectorFields.js";
import { NativeCancelSignIn } from "./NativeCancelSignIn.js";
import { linearAuthorization } from "./linear-authorization-ui.js";
import type {
  NativeAuthorizationSink,
  NativeAuthorizationTicket,
} from "./native-connector-controller.js";

function linearOptions(plan: ConnectPlan): SelfHostedConnectorOptions {
  const config = selfHostedConfig(plan);
  return {
    mode: "managed",
    workspace: "",
    appScopes: defaultSelections(config?.appScopes ?? []),
    userScopes: defaultSelections(config?.userScopes ?? []),
    webhookResourceTypes: defaultSelections(config?.webhookResourceTypes ?? []),
    webhookEnabled: false,
    webhookUrl: "",
    icon: "",
  };
}
function linearState(initial: ReturnType<typeof initialDraftState>) {
  return {
    ...initial,
    oauth: {
      ...initial.oauth,
      clientId: initial.oauth.clientId || linearClientId(),
      clientSecret: "",
      tokenAuth: "none" as const,
      pkce: "required" as const,
    },
  };
}

type LinearFormProps = {
  plan: ConnectPlan;
  connectorId?: string;
  onFlash: (flash: Flash) => void;
  onSaved: () => void;
  onAuthorization?: NativeAuthorizationSink;
  authorization?: NativeAuthorizationTicket | null;
  captureUiCurrent?: () => () => boolean;
};

function useLinearForm(props: LinearFormProps) {
  const { plan, connectorId, onFlash, onSaved } = props;
  const held = connectorId ? readSelfHostedConnector(connectorId) : null;
  const [options, setOptions] = useState(
    () => held?.options ?? linearOptions(plan),
  );
  const [state, setState] = useState<DraftState>(() =>
    linearState(held?.state ?? initialDraftState(plan, "oauth")),
  );
  const [saving, setSaving] = useState<(() => boolean) | null>(null);
  const [iconBusy, setIconBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [savedId, setSavedId] = useState(connectorId);
  const problems = linearConnectorProblems(state, options, savedId);
  const busy = !!saving?.() || !!props.authorization?.current();

  async function configure(event: FormEvent) {
    event.preventDefault();
    if (busy || iconBusy || problems.length > 0) return;
    const current = props.captureUiCurrent?.() ?? (() => true);
    if (!current()) return;
    const authorization = linearAuthorization(savedId, props.onAuthorization);
    setSaving(() => current);
    setFailure(null);
    try {
      const connection = await configureLinearConnector(
        state,
        options,
        savedId,
        (next) => {
          authorization.bind(next);
          if (current()) setSavedId(next);
        },
        authorization.reserve,
      );
      if (!current()) return;
      setState({
        ...state,
        key: "",
        oauth: { ...state.oauth, clientSecret: "" },
      });
      onFlash({
        tone: connection.status === "active" ? "ok" : "warn",
        text:
          connection.status === "active"
            ? `Linear connected to ${connection.accountLabel ?? "your workspace"}${kvDurability() === "memory" ? " for this session" : ""}.`
            : "Linear configuration saved. Complete authorization with Linear.",
      });
      onSaved();
    } catch (error) {
      if (current()) {
        const text = errorText(error);
        setFailure(text);
        onFlash({ tone: "err", text });
      }
    } finally {
      authorization.finish();
      if (current()) setSaving(null);
    }
  }
  return {
    state,
    options,
    busy,
    iconBusy,
    failure,
    savedId,
    problems,
    setState,
    setOptions,
    setIconBusy,
    configure,
  };
}

function LinearFormView({
  props,
  model,
}: {
  props: LinearFormProps;
  model: ReturnType<typeof useLinearForm>;
}) {
  const {
    state,
    options,
    busy,
    iconBusy,
    failure,
    savedId,
    problems,
    setState,
    setOptions,
    setIconBusy,
    configure,
  } = model;

  return (
    <form
      className="cx-form panel__body"
      onSubmit={(event) => void configure(event)}
    >
      <fieldset className="cx-block" disabled={busy || iconBusy}>
        <legend className="visually-hidden">
          Linear connector configuration
        </legend>
        <div className="cx-form">
          <LinearConnectorFields
            plan={props.plan}
            state={state}
            options={options}
            onState={setState}
            onOptions={setOptions}
            onIconBusyChange={setIconBusy}
            onError={(text) => props.onFlash({ tone: "err", text })}
          />
        </div>
      </fieldset>
      {failure ? <StatusMark tone="err" label={failure} /> : null}
      {props.onAuthorization === undefined ? (
        <LinearCancelSignIn authorizing={busy && state.method === "oauth"} />
      ) : null}
      <FormCommit
        label={
          state.method === "api-key"
            ? "Verify and connect Linear"
            : savedId
              ? "Save and authorize Linear"
              : "Create and authorize Linear"
        }
        busy={busy}
        disabled={busy || iconBusy || problems.length > 0}
      >
        <NativeCancelSignIn
          busy={busy}
          authorization={
            props.authorization === undefined ? null : props.authorization
          }
          onCancel={() => props.authorization?.cancel()}
        />
        {problems[0] ? <StatusMark tone="warn" label={problems[0]} /> : null}
      </FormCommit>
    </form>
  );
}

export function LinearConnectorForm(props: LinearFormProps) {
  return <LinearFormView props={props} model={useLinearForm(props)} />;
}
