import {
  type DraftState,
  draftStateFromDetail,
  toConnectorDraft,
} from "@opensesame/app-core/lib/connect-draft.js";
import type { ConnectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import {
  type ConnectorDetail,
  readConnector,
  updateConnector,
} from "@opensesame/app-core/lib/vercel-connect-manage.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { type FormEvent, useEffect, useState } from "react";
import { FormCommit } from "../../../components/FormCommit.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { ConnectorIdentity } from "./ConnectCreateForm.js";
import { MethodFields } from "./MethodFields.js";
import { Facts } from "./fields.js";

/** What Connect holds for this connector, editable in place. */
export function ConnectorSettingsForm({
  plan,
  connectorId,
  canManage,
  online,
  onFlash,
}: {
  plan: ConnectPlan;
  connectorId: string;
  canManage: boolean;
  online: boolean;
  onFlash: (flash: Flash) => void;
}) {
  const [detail, setDetail] = useState<ConnectorDetail | null>(null);
  const [state, setState] = useState<DraftState | null>(null);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!canManage) return;
    let live = true;
    void readConnector(connectorId)
      .then((read) => {
        if (!live) return;
        setDetail(read);
        setState(draftStateFromDetail(plan, read));
        setFailure("");
      })
      .catch((error) => {
        if (live) setFailure(errorText(error));
      });
    return () => {
      live = false;
    };
  }, [plan, connectorId, canManage]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!state) return;
    setBusy(true);
    try {
      const saved = await updateConnector(connectorId, toConnectorDraft(state));
      setDetail(saved);
      onFlash({ tone: "ok", text: `${saved.name || plan.name} saved.` });
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  if (failure) return <StatusMark tone="err" label={failure} />;
  if (!state || !detail) {
    return <Facts rows={[["Connector", connectorId]]} />;
  }
  return (
    <form className="cx-form panel__body" onSubmit={save}>
      <Facts
        rows={[
          ["ID", detail.id],
          ["Type", detail.type || state.method],
          ["Service", detail.service || plan.id],
        ]}
      />
      <ConnectorIdentity state={state} onState={setState} />
      {state.method === "managed" ? null : (
        <MethodFields
          plan={plan}
          state={state}
          onState={setState}
          redirectUri={detail.redirectUri}
        />
      )}
      <FormCommit
        label={busy ? "Saving connector" : "Save connector"}
        busy={busy}
        disabled={busy || !online || !canManage}
      />
    </form>
  );
}
