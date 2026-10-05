/**
 * One tailnet device: what it is, what about it needs someone, and the keys
 * its pairing's role allows — approve one waiting, open its settings, expire
 * its key, remove it. Every change goes through the daemon (ADR 0165).
 */

import {
  deviceMarks,
  shortName,
} from "@opensesame/app-core/lib/tailnet-admin/model.js";
import type { TailnetDevice } from "@opensesame/app-core/lib/tailnet-admin/wire.js";
import { IconKey } from "../../components/IconKey.js";
import {
  IconCheck,
  IconClock,
  IconEdit,
  IconMonitor,
  IconPhone,
  IconTrash,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { byId } from "../../lib/use-focus-after.js";
import { ArmedKey } from "./ArmedKey.js";
import type { TailnetModel } from "./use-tailnet-admin.js";

export const ADD_DEVICE_KEY_ID = "tailnet-add-device";
export const editKeyId = (id: string) => `tailnet-device-edit-${id}`;

const HANDHELD = /^(ios|ipados|android)$/i;

function facts(device: TailnetDevice): string {
  const version = device.clientVersion
    ? `Tailscale ${device.clientVersion}`
    : "";
  return [device.os, version, device.user, ...device.tags]
    .filter(Boolean)
    .join(" · ");
}

function DeviceKeys({
  device,
  name,
  model,
  onEdit,
}: {
  device: TailnetDevice;
  name: string;
  model: TailnetModel;
  onEdit: (device: TailnetDevice) => void;
}) {
  const { busy, admin, run } = model;
  return (
    <div className="actions">
      {device.authorized ? null : (
        <IconKey
          label={`Approve ${name}`}
          small
          disabled={busy}
          onClick={() =>
            void run(
              () => admin.setAuthorized(device.id, true),
              byId(editKeyId(device.id)),
            )
          }
        >
          <IconCheck size={16} />
        </IconKey>
      )}
      <IconKey
        id={editKeyId(device.id)}
        label={`Settings for ${name}`}
        small
        disabled={busy}
        onClick={() => onEdit(device)}
      >
        <IconEdit size={16} />
      </IconKey>
      {device.external ? null : (
        <ArmedKey
          model={model}
          arm={{ action: "expire", id: device.id }}
          label={`Expire ${name}'s key`}
          confirmLabel={`Confirm expiring ${name}'s key; it must sign in again`}
          keepLabel={`Keep ${name}'s key`}
          onConfirm={() =>
            void run(() => admin.expire(device.id), byId(editKeyId(device.id)))
          }
        >
          <IconClock size={16} />
        </ArmedKey>
      )}
      <ArmedKey
        model={model}
        arm={{ action: "remove", id: device.id }}
        danger
        label={`Remove ${name} from the tailnet`}
        confirmLabel={`Confirm removing ${name} from the tailnet`}
        keepLabel={`Keep ${name}`}
        onConfirm={() =>
          void run(() => admin.deleteDevice(device.id), byId(ADD_DEVICE_KEY_ID))
        }
      >
        <IconTrash size={16} />
      </ArmedKey>
    </div>
  );
}

export function DeviceRow({
  device,
  model,
  now,
  onEdit,
}: {
  device: TailnetDevice;
  model: TailnetModel;
  now: number;
  onEdit: (device: TailnetDevice) => void;
}) {
  const name = shortName(device);
  return (
    <li className="identity-row tailnet-row" id={`tailnet-device-${device.id}`}>
      <div className="identity-row__main">
        <span className="identity-row__mark" aria-hidden="true">
          {HANDHELD.test(device.os) ? (
            <IconPhone size={18} />
          ) : (
            <IconMonitor size={18} />
          )}
        </span>
        <div className="identity-row__id">
          <div className="identity-row__title">
            <h3>{name}</h3>
          </div>
          <code className="identity-ref">
            {device.addresses[0] ?? device.name}
          </code>
          <span className="identity-row__when">{facts(device)}</span>
          <span className="tailnet-row__marks">
            {deviceMarks(device, now).map((mark) => (
              <StatusMark
                key={mark.label}
                tone={mark.tone}
                label={mark.label}
              />
            ))}
          </span>
        </div>
        {model.canManage ? (
          <DeviceKeys
            device={device}
            name={name}
            model={model}
            onEdit={onEdit}
          />
        ) : null}
      </div>
    </li>
  );
}
