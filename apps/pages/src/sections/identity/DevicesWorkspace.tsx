import {
  type LocalDevice,
  removeLocalDevice,
  thisDeviceId,
} from "@opensesame/app-core/lib/local-devices.js";
import { formatTime } from "@opensesame/app-core/sections/identity-section-model.js";
import { type ReactNode, useEffect, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { IconKey, ReloadKey } from "../../components/IconKey.js";
import { IconEdit, IconTrash, IconX } from "../../components/Icons.js";
import { RecordWorkspace } from "../../components/RecordWorkspace.js";
import { IdentityFact } from "./IdentityRecordFields.js";
import { DeviceForm, type DevicesModel } from "./LocalDeviceRows.js";
import { useDevices } from "./LocalDevicesPanel.js";
import { LocalIdentityNotices } from "./LocalIdentityNotices.js";
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
  const rows = deviceWorkspaceRows(devices ?? [], !!tailnet, !!approval);
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
      {draft ? (
        <div className="detail">
          <div className="detail__head">
            <h1>Edit {selected?.name}</h1>
          </div>
          <DeviceForm model={formModel} />
        </div>
      ) : selected ? (
        <DeviceDetail
          model={model}
          device={selected}
          onEdit={() =>
            navigate(
              `${listPath}&action=edit#${encodeURIComponent(selected.id)}`,
            )
          }
        />
      ) : selectedId === "approve-device" ? (
        approval
      ) : selectedId === "tailnet-devices" ? (
        tailnet
      ) : null}
    </RecordWorkspace>
  );
}

function deviceWorkspaceRows(
  devices: LocalDevice[],
  tailnet: boolean,
  approval: boolean,
) {
  const listPath = "/identity?view=devices";
  const rows = devices.map((device) => ({
    id: device.id,
    label: device.name,
    extension: "device",
    to: `${listPath}#${encodeURIComponent(device.id)}`,
  }));
  if (tailnet)
    rows.push({
      id: "tailnet-devices",
      label: "Tailnet devices",
      extension: "",
      to: `${listPath}#tailnet-devices`,
    });
  if (approval)
    rows.push({
      id: "approve-device",
      label: "Approve a device",
      extension: "",
      to: `${listPath}#approve-device`,
    });
  return rows;
}
function DeviceDetail({
  model,
  device,
  onEdit,
}: { model: DevicesModel; device: LocalDevice; onEdit: () => void }) {
  return (
    <div className="detail" id={device.id}>
      <div className="detail__head">
        <div className="detail__heading">
          <h1>{device.name}</h1>
          <div className="detail__meta">
            Device ·{" "}
            {device.id === thisDeviceId() ? "This device" : device.platform}
          </div>
        </div>
        <div className="actions">
          <IconKey
            label={`Edit ${device.name}`}
            small
            disabled={model.busy}
            onClick={onEdit}
          >
            <IconEdit size={16} />
          </IconKey>
          {device.id !== thisDeviceId() ? (
            <DeviceRemoval model={model} device={device} />
          ) : null}
        </div>
      </div>
      <section className="detail__group">
        <h2 className="detail__grouphead">Device</h2>
        <IdentityFact label="ID">{device.id}</IdentityFact>
        <IdentityFact label="Platform">{device.platform}</IdentityFact>
        <IdentityFact label="Added">
          {formatTime(device.createdAt)}
        </IdentityFact>
        <IdentityFact label="Last seen">
          {formatTime(device.lastSeenAt)}
        </IdentityFact>
      </section>
    </div>
  );
}
function DeviceRemoval({
  model,
  device,
}: { model: DevicesModel; device: LocalDevice }) {
  const armed = model.armed?.id === device.id;
  return (
    <>
      <IconKey
        label={
          armed ? `Confirm removing ${device.name}` : `Remove ${device.name}`
        }
        small
        armed={armed}
        disabled={model.busy}
        onClick={() =>
          armed
            ? void model.run(
                () => removeLocalDevice(model.tomb, device.id),
                () => model.reloadKey.current,
              )
            : model.setArmed({ action: "remove", id: device.id })
        }
      >
        <IconTrash size={16} />
      </IconKey>
      {armed ? (
        <IconKey
          label={`Keep ${device.name}`}
          small
          onClick={() => model.setArmed(null)}
        >
          <IconX size={16} />
        </IconKey>
      ) : null}
    </>
  );
}
