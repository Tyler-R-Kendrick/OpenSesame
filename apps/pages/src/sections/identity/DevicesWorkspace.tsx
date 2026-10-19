import { type ReactNode, useEffect, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { ReloadKey } from "../../components/IconKey.js";
import { RecordWorkspace } from "../../components/RecordWorkspace.js";
import { useDevices } from "./LocalDevicesPanel.js";
import { LocalIdentityNotices } from "./LocalIdentityNotices.js";
import { deviceWorkspaceListRows } from "./device-workspace-rows.js";
import { DevicesWorkspaceBody } from "./devices-workspace-detail.js";
import { identityRecordId } from "./identity-record-selection.js";

export function DevicesWorkspace({
  tomb,
  approval,
  tailnet,
}: { tomb: string; approval?: ReactNode; tailnet?: ReactNode }) {
  const navigate = useNavigate();
  const { hash } = useLocation();
  const [params] = useSearchParams();
  const selectedId = identityRecordId(hash);
  const editing = params.get("action") === "edit";
  const listPath = "/identity?view=devices";
  const model = useDevices(tomb, (next) =>
    navigate(
      next.some((device) => device.id === selectedId)
        ? `${listPath}#${encodeURIComponent(selectedId ?? "")}`
        : listPath,
      { replace: true },
    ),
  );
  const { devices, draft, busy, error } = model;
  const selected = devices?.find((device) => device.id === selectedId);
  const setDraft = model.setDraft;
  const draftRoute = useRef("");
  useEffect(() => {
    if (editing && !selected) return;
    const route = `${editing}:${selectedId}`;
    if (draftRoute.current === route) return;
    draftRoute.current = route;
    if (editing && selected) setDraft({ id: selected.id, name: selected.name });
    else setDraft(null);
  }, [editing, selectedId, selected, setDraft]);
  const formModel = {
    ...model,
    setDraft: (value: typeof draft) => {
      model.setDraft(value);
      if (!value)
        navigate(
          selected
            ? `${listPath}#${encodeURIComponent(selected.id)}`
            : listPath,
        );
    },
  };
  const deviceIds = new Set((devices ?? []).map((device) => device.id));
  const rows = deviceWorkspaceListRows(devices ?? [], {
    tailnet: !!tailnet,
    approval: !!approval,
  }).map((row) => ({
    id: row.id,
    label: row.label,
    extension: deviceIds.has(row.id) ? "device" : "",
    to: row.href,
    counted: row.counted,
  }));
  return (
    <RecordWorkspace
      section="Identity"
      title="Devices"
      rootPath="/identity"
      listPath={listPath}
      rows={rows}
      selectedId={selectedId}
      detailOpen={!!draft || !!selectedId}
      status={
        <LocalIdentityNotices
          id="identity:local-devices"
          title={"Devices"}
          error={error}
        />
      }
      commands={
        <fieldset className="vtree__keys" aria-label="Device commands">
          <ReloadKey
            label="Reload browsers"
            keyRef={model.reloadKey}
            disabled={busy}
            onReload={model.reload}
          />
        </fieldset>
      }
    >
      <DevicesWorkspaceBody
        model={model}
        formModel={formModel}
        draft={draft}
        selected={selected}
        selectedId={selectedId}
        approval={approval}
        tailnet={tailnet}
        onEditSelected={() =>
          selected
            ? navigate(
                `${listPath}&action=edit#${encodeURIComponent(selected.id)}`,
              )
            : undefined
        }
      />
    </RecordWorkspace>
  );
}
