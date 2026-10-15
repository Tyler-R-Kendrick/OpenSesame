import {
  type LocalDevice,
  removeLocalDevice,
  thisDeviceId,
} from "@opensesame/app-core/lib/local-devices.js";
import { formatTime } from "@opensesame/app-core/sections/identity-section-model.js";
import type { ReactNode } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconEdit, IconTrash, IconX } from "../../components/Icons.js";
import { IdentityFact } from "./IdentityRecordFields.js";
import { DeviceForm, type DevicesModel } from "./LocalDeviceRows.js";

export function DevicesWorkspaceBody({
  model,
  formModel,
  draft,
  selected,
  selectedId,
  approval,
  tailnet,
  onEditSelected,
}: {
  model: DevicesModel;
  formModel: DevicesModel;
  draft: DevicesModel["draft"];
  selected: LocalDevice | undefined;
  selectedId: string | null;
  approval?: ReactNode;
  tailnet?: ReactNode;
  onEditSelected: () => void;
}) {
  if (draft) {
    return (
      <div className="detail">
        <div className="detail__head">
          <h1>Edit {selected?.name}</h1>
        </div>
        <DeviceForm model={formModel} />
      </div>
    );
  }
  if (selected) {
    return (
      <DeviceDetail model={model} device={selected} onEdit={onEditSelected} />
    );
  }
  if (selectedId === "approve-device") return approval ?? null;
  if (selectedId === "tailnet-devices") return tailnet ?? null;
  return null;
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
