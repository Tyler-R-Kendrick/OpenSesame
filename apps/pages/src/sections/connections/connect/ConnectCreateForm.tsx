import { draftProblems } from "@opensesame/app-core/lib/connect-create.js";
import {
  type DraftState,
  initialDraftState,
  toConnectorDraft,
} from "@opensesame/app-core/lib/connect-draft.js";
import type { ConnectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { createConfiguredConnector } from "@opensesame/app-core/lib/vercel-connect-manage.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { type FormEvent, useState } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconPlus } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { MethodFields } from "./MethodFields.js";
import { MethodPicker } from "./fields.js";

/** Name and UID: how Connect and the SDK address this connector. */
export function ConnectorIdentity({
  state,
  onState,
}: {
  state: DraftState;
  onState: (next: DraftState) => void;
}) {
  return (
    <fieldset className="cx-block">
      <legend>Connector details</legend>
      <div className="cx-grid">
        <FieldShell
          label="Name"
          value={state.name}
          onValueChange={(name) => onState({ ...state, name })}
        />
        <FieldShell
          label="UID"
          value={state.uid}
          mono
          onValueChange={(uid) => onState({ ...state, uid })}
        />
      </div>
    </fieldset>
  );
}

/** A connector's whole configuration, filled from its plan, then created. */
export function ConnectCreateForm({
  plan,
  canManage,
  online,
  onFlash,
  onCreated,
}: {
  plan: ConnectPlan;
  canManage: boolean;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onCreated: () => void;
}) {
  const [state, setState] = useState<DraftState>(() => initialDraftState(plan));
  const [busy, setBusy] = useState(false);
  const problems = draftProblems(toConnectorDraft(state));

  async function create(event: FormEvent) {
    event.preventDefault();
    if (problems.length > 0) return;
    setBusy(true);
    try {
      const created = await createConfiguredConnector(
        plan,
        toConnectorDraft(state),
      );
      onFlash({
        tone: "ok",
        text: `${created.displayName} is ready to authorize.`,
      });
      onCreated();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="cx-form panel__body" onSubmit={create}>
      <MethodPicker
        plan={plan}
        method={state.method}
        onMethod={(method) =>
          setState({
            ...initialDraftState(plan, method),
            name: state.name,
            uid: state.uid,
          })
        }
      />
      <ConnectorIdentity state={state} onState={setState} />
      <MethodFields plan={plan} state={state} onState={setState} />
      <FormCommit
        label={busy ? "Creating connector" : "Create connector"}
        icon={<IconPlus size={18} />}
        busy={busy}
        disabled={busy || !online || !canManage || problems.length > 0}
      >
        {problems[0] ? <StatusMark tone="warn" label={problems[0]} /> : null}
      </FormCommit>
    </form>
  );
}
