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

export function LinearConnectorForm({
  plan,
  connectorId,
  onFlash,
  onSaved,
}: {
  plan: ConnectPlan;
  connectorId?: string;
  onFlash: (flash: Flash) => void;
  onSaved: () => void;
}) {
  const held = connectorId ? readSelfHostedConnector(connectorId) : null;
  const [options, setOptions] = useState(
    () => held?.options ?? linearOptions(plan),
  );
  const [state, setState] = useState<DraftState>(() =>
    linearState(held?.state ?? initialDraftState(plan, "oauth")),
  );
  const [busy, setBusy] = useState(false);
  const [iconBusy, setIconBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [savedId, setSavedId] = useState(connectorId);
  const problems = linearConnectorProblems(state, options, savedId);

  async function configure(event: FormEvent) {
    event.preventDefault();
    if (busy || iconBusy || problems.length > 0) return;
    setBusy(true);
    setFailure(null);
    try {
      const connection = await configureLinearConnector(
        state,
        options,
        savedId,
        setSavedId,
      );
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
      const text = errorText(error);
      setFailure(text);
      onFlash({ tone: "err", text });
    } finally {
      setBusy(false);
    }
  }

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
            plan={plan}
            state={state}
            options={options}
            onState={setState}
            onOptions={setOptions}
            onIconBusyChange={setIconBusy}
            onError={(text) => onFlash({ tone: "err", text })}
          />
        </div>
      </fieldset>
      {failure ? <StatusMark tone="err" label={failure} /> : null}
      <LinearCancelSignIn authorizing={busy && state.method === "oauth"} />
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
        {problems[0] ? <StatusMark tone="warn" label={problems[0]} /> : null}
      </FormCommit>
    </form>
  );
}
