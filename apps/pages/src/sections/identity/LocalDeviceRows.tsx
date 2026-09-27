/**
 * The Devices list's rows and its one form, drawn with the same keys as the
 * rest of Identity (DESIGN.md § Actions are symbols): edit is the pencil,
 * removal is an armed trash key with a keep beside it, and a registration
 * this browser is the device for is claimed with the check — armed the same
 * way, because a claim folds this browser's own record away for good.
 */

import {
  DEVICE_PLATFORMS,
  type LocalDevice,
  claimLocalDevice,
  isPendingDevice,
  registerLocalDevice,
  removeLocalDevice,
  thisDeviceId,
  updateLocalDevice,
} from "@opensesame/app-core/lib/local-devices.js";
import { formatTime } from "@opensesame/app-core/sections/identity-section-model.js";
import { type ReactNode, useEffect, useRef } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import {
  IconCheck,
  IconEdit,
  IconMonitor,
  IconPhone,
  IconTrash,
  IconX,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

/** `id` is empty for a device being registered. */
export type DeviceDraft = {
  id: string;
  name: string;
  platform: string;
  /** Whether the platform may still be chosen: a new or unseen device. */
  pending: boolean;
};

export type DevicesModel = {
  tomb: string;
  devices: LocalDevice[] | null;
  draft: DeviceDraft | null;
  setDraft: (draft: DeviceDraft | null) => void;
  /** The armed key, as `remove:<id>` or `claim:<id>`, or null. */
  armed: string | null;
  setArmed: (key: string | null) => void;
  busy: boolean;
  error: string;
  /**
   * Run a change; on success focus lands on the element with `focusId`,
   * since the key that was pressed may be gone with its row.
   */
  run: (
    action: () => Promise<LocalDevice[]>,
    focusId?: string,
  ) => Promise<void>;
};

/** The panel head's add key, where focus goes when a row it was on leaves. */
export const NEW_DEVICE_KEY_ID = "local-device-new";

export function editKeyId(id: string): string {
  return `local-device-edit-${id}`;
}

export function newDeviceDraft(): DeviceDraft {
  return { id: "", name: "", platform: "", pending: true };
}

function editDraft(device: LocalDevice): DeviceDraft {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    pending: isPendingDevice(device),
  };
}

function isHandheld(platform: string): boolean {
  return platform === "iOS" || platform === "Android";
}

function deviceState(device: LocalDevice, mine: string) {
  if (device.id === mine) return { tone: "ok", label: "This device" } as const;
  if (isPendingDevice(device))
    return {
      tone: "warn",
      label: "Registered, not yet opened on that device",
    } as const;
  return { tone: "ok", label: "Has opened this vault" } as const;
}

function deviceWhen(device: LocalDevice): string {
  const added = `added ${formatTime(device.createdAt)}`;
  const seen = isPendingDevice(device)
    ? "never seen"
    : `last seen ${formatTime(device.lastSeenAt)}`;
  return `${device.platform} · ${added} · ${seen}`;
}

export function DeviceRows({ model }: { model: DevicesModel }) {
  const mine = thisDeviceId();
  return (
    <ul className="identity-rows">
      {model.devices?.map((device) => (
        <DeviceRow key={device.id} device={device} mine={mine} model={model} />
      ))}
    </ul>
  );
}

function DeviceRow({
  device,
  mine,
  model,
}: {
  device: LocalDevice;
  mine: string;
  model: DevicesModel;
}) {
  const { tomb, draft, setDraft, busy } = model;
  const state = deviceState(device, mine);
  const locked = busy || draft !== null;
  return (
    <li className="identity-row" id={device.id}>
      <div className="identity-row__main">
        <span className="identity-row__mark" aria-hidden="true">
          {isHandheld(device.platform) ? (
            <IconPhone size={18} />
          ) : (
            <IconMonitor size={18} />
          )}
        </span>
        <div className="identity-row__id">
          <div className="identity-row__title">
            <h3>{device.name}</h3>
            <StatusMark tone={state.tone} label={state.label} />
          </div>
          <code className="identity-ref">{device.id}</code>
          <span className="identity-row__when">{deviceWhen(device)}</span>
        </div>
        <div className="actions">
          {isPendingDevice(device) ? (
            <ArmedKeys
              model={model}
              armKey={`claim:${device.id}`}
              label={`Claim ${device.name} as this device`}
              confirmLabel={`Confirm claiming ${device.name} as this device`}
              keepLabel={`Leave ${device.name} unclaimed`}
              onConfirm={() =>
                model.run(
                  () => claimLocalDevice(tomb, device.id),
                  editKeyId(mine),
                )
              }
            >
              <IconCheck size={16} />
            </ArmedKeys>
          ) : null}
          <IconKey
            id={editKeyId(device.id)}
            label={`Edit ${device.name}`}
            small
            disabled={locked}
            onClick={() => setDraft(editDraft(device))}
          >
            <IconEdit size={16} />
          </IconKey>
          {device.id === mine ? null : (
            <ArmedKeys
              model={model}
              armKey={`remove:${device.id}`}
              danger
              label={`Remove ${device.name}`}
              confirmLabel={`Confirm removing ${device.name}`}
              keepLabel={`Keep ${device.name}`}
              onConfirm={() =>
                model.run(
                  () => removeLocalDevice(tomb, device.id),
                  NEW_DEVICE_KEY_ID,
                )
              }
            >
              <IconTrash size={16} />
            </ArmedKeys>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * A key that one press arms and a second press fires, with a keep beside it
 * while armed that hands focus back to the key it disarmed.
 */
function ArmedKeys({
  model,
  armKey,
  danger = false,
  label,
  confirmLabel,
  keepLabel,
  onConfirm,
  children,
}: {
  model: DevicesModel;
  armKey: string;
  danger?: boolean;
  label: string;
  confirmLabel: string;
  keepLabel: string;
  onConfirm: () => Promise<void>;
  children: ReactNode;
}) {
  const { draft, busy, armed, setArmed } = model;
  const isArmed = armed === armKey;
  const primary = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconKey
        keyRef={primary}
        label={isArmed ? confirmLabel : label}
        small
        danger={danger}
        armed={isArmed}
        disabled={busy || draft !== null}
        onClick={() => (isArmed ? void onConfirm() : setArmed(armKey))}
      >
        {children}
      </IconKey>
      {isArmed ? (
        <IconKey
          label={keepLabel}
          small
          disabled={busy}
          onClick={() => {
            setArmed(null);
            primary.current?.focus();
          }}
        >
          <IconX size={16} />
        </IconKey>
      ) : null}
    </>
  );
}

function useDraftFocus(
  draftId: string | undefined,
  error: string,
  busy: boolean,
) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (error && !busy && draftId !== undefined) input.current?.focus();
  }, [error, busy, draftId]);
  useEffect(() => {
    if (draftId === undefined) return;
    const previous = document.activeElement;
    const field = input.current;
    field?.focus();
    return () => {
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        (document.activeElement === document.body ||
          field?.form?.contains(document.activeElement))
      )
        previous.focus();
    };
  }, [draftId]);
  return input;
}

export function DeviceForm({ model }: { model: DevicesModel }) {
  const { tomb, draft, setDraft, busy, error, run } = model;
  const input = useDraftFocus(draft?.id, error, busy);
  if (!draft) return null;
  const creating = draft.id === "";
  // A seen device's platform is not edited, so only a pending one needs it.
  const ready =
    draft.name.trim() !== "" && (!draft.pending || draft.platform !== "");
  return (
    <form
      aria-label={creating ? "New device" : `Edit ${draft.name || "device"}`}
      onSubmit={(event) => {
        event.preventDefault();
        void run(() =>
          creating
            ? registerLocalDevice(tomb, draft)
            : updateLocalDevice(tomb, draft.id, {
                name: draft.name,
                ...(draft.pending ? { platform: draft.platform } : {}),
              }),
        );
      }}
    >
      <div className="field">
        <label className="label" htmlFor="local-device-name">
          Name
        </label>
        <input
          ref={input}
          id="local-device-name"
          required
          maxLength={128}
          autoComplete="off"
          disabled={busy}
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </div>
      {draft.pending ? (
        <div className="field">
          <label className="label" htmlFor="local-device-platform">
            Platform
          </label>
          <select
            id="local-device-platform"
            required
            disabled={busy}
            value={draft.platform}
            onChange={(event) =>
              setDraft({ ...draft, platform: event.target.value })
            }
          >
            <option value="">Select a platform</option>
            {DEVICE_PLATFORMS.map((platform) => (
              <option key={platform} value={platform}>
                {platform === "Unknown" ? "Other" : platform}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <FormCommit
        label={creating ? "Register device" : "Save changes"}
        disabled={busy || !ready}
      >
        <IconKey label="Cancel" disabled={busy} onClick={() => setDraft(null)}>
          <IconX size={16} />
        </IconKey>
      </FormCommit>
    </form>
  );
}
