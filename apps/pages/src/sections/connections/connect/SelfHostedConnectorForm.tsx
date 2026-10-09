import type { ConnectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { kvDurability } from "@opensesame/app-core/lib/kv.js";
import {
  defaultSelections,
  selfHostedConfig,
} from "@opensesame/app-core/lib/self-hosted-config.js";
import {
  type SelfHostedConnectorOptions,
  hasSavedSelfHostedCredential,
  readSelfHostedConnector,
  saveSelfHostedConnectorDurable,
  selfHostedConnectorProblems,
} from "@opensesame/app-core/lib/self-hosted-connectors.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { type FormEvent, useState } from "react";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconPlus } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";

import {
  SelfHostedConfigFields,
  localState,
} from "./SelfHostedConfigFields.js";

function initialOptions(plan: ConnectPlan): SelfHostedConnectorOptions {
  const config = selfHostedConfig(plan);
  return {
    mode:
      plan.methods.some((method) => method.kind === "managed") &&
      plan.methods.some((method) => method.kind === "oauth")
        ? "managed"
        : "byo",
    workspace: "",
    appScopes: defaultSelections(config?.appScopes ?? []),
    userScopes: defaultSelections(config?.userScopes ?? []),
    webhookResourceTypes: defaultSelections(config?.webhookResourceTypes ?? []),
    icon: "",
  };
}

/** The configuration experience belongs to the selected provider and this device. */
export function SelfHostedConnectorForm({
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
    () => held?.options ?? initialOptions(plan),
  );
  const [state, setState] = useState(() => {
    const next = held?.state ?? localState(plan);
    return { ...next, oauth: { ...next.oauth, scopes: options.appScopes } };
  });
  const [busy, setBusy] = useState(false);
  const [iconBusy, setIconBusy] = useState(false);
  const [savedId, setSavedId] = useState(connectorId);
  const problems = selfHostedConnectorProblems(plan, state, options, savedId);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || iconBusy || problems.length > 0) return;
    setBusy(true);
    try {
      const saved = await saveSelfHostedConnectorDurable(
        plan,
        state,
        options,
        savedId,
      );
      setSavedId(saved.connectionId);
      setState({
        ...state,
        key: "",
        mcpClientSecret: "",
        oauth: { ...state.oauth, clientSecret: "" },
      });
      onFlash({
        tone: kvDurability() === "memory" ? "warn" : "ok",
        text:
          kvDurability() === "memory"
            ? `${saved.displayName} configuration is kept for this session.`
            : `${saved.displayName} configuration is saved on this device.`,
      });
      onSaved();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="cx-form panel__body"
      onSubmit={(event) => void save(event)}
    >
      <fieldset className="cx-block" disabled={busy || iconBusy}>
        <legend className="visually-hidden">Connector configuration</legend>
        <div className="cx-form">
          <SelfHostedConfigFields
            plan={plan}
            state={state}
            options={options}
            hasCredential={hasSavedSelfHostedCredential(state, savedId)}
            onState={setState}
            onOptions={setOptions}
            onIconBusyChange={setIconBusy}
            onFlash={onFlash}
          />
        </div>
      </fieldset>
      <FormCommit
        label={savedId ? "Save connector" : "Create Connector"}
        icon={<IconPlus size={18} />}
        busy={busy}
        disabled={busy || iconBusy || problems.length > 0}
      >
        {problems[0] ? <StatusMark tone="warn" label={problems[0]} /> : null}
      </FormCommit>
    </form>
  );
}
