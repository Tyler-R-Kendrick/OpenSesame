/**
 * The browsers that opened this vault, drawn with the same keys as the rest
 * of Identity (DESIGN.md § Actions are symbols): rename is the pencil, and
 * removal is an armed trash key with a keep beside it. A browser lists itself
 * when it opens the vault; nothing here invents a device (ADR 0167 — the
 * tailnet's real machines are managed in the panel above).
 */

import {
  type LocalDevice,
  isPendingDevice,
  removeLocalDevice,
  thisDeviceId,
  updateLocalDevice,
} from "@opensesame/app-core/lib/local-devices.js";
import { formatTime } from "@opensesame/app-core/sections/identity-section-model.js";
import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import {
  IconEdit,
  IconMonitor,
  IconPhone,
  IconTrash,
  IconX,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import type { FocusTarget } from "../../lib/use-focus-after.js";

/** A key one more press will fire: which action, on which device. */
export type ArmedKey = { action: "remove"; id: string };

/** A browser being renamed. */
export type DeviceDraft = { id: string; name: string };

export type DevicesModel = {
  tomb: string;
  devices: LocalDevice[] | null;
  draft: DeviceDraft | null;
  setDraft: (draft: DeviceDraft | null) => void;
  /** The key one more press will fire, or null. */
  armed: ArmedKey | null;
  setArmed: (key: ArmedKey | null) => void;
  busy: boolean;
  error: string;
  /**
   * Run a change; on success focus lands on `focus`, since the key that was
   * pressed may be gone with its row.
   */
  run: (
    action: () => Promise<LocalDevice[]>,
    focus?: FocusTarget,
  ) => Promise<void>;
  /** The panel head's reload, where focus goes when a row it was on leaves. */
  reloadKey: RefObject<HTMLButtonElement | null>;
};

export function editKeyId(id: string): string {
  return `local-device-edit-${id}`;
}

function isHandheld(platform: string): boolean {
  return platform === "iOS" || platform === "Android";
}

function deviceState(device: LocalDevice, mine: string) {
  if (device.id === mine) return { tone: "ok", label: "This device" } as const;
  if (isPendingDevice(device))
    return {
      tone: "idle",
      label: "Typed in by hand; no browser opened the vault as it",
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
          <IconKey
            id={editKeyId(device.id)}
            label={`Edit ${device.name}`}
            small
            disabled={locked}
            onClick={() => setDraft({ id: device.id, name: device.name })}
          >
            <IconEdit size={16} />
          </IconKey>
          {device.id === mine ? null : (
            <ArmedKeys
              model={model}
              armKey={{ action: "remove", id: device.id }}
              danger
              label={`Remove ${device.name}`}
              confirmLabel={`Confirm removing ${device.name}`}
              keepLabel={`Keep ${device.name}`}
              onConfirm={() =>
                model.run(
                  () => removeLocalDevice(tomb, device.id),
                  () => model.reloadKey.current,
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
  armKey: ArmedKey;
  danger?: boolean;
  label: string;
  confirmLabel: string;
  keepLabel: string;
  onConfirm: () => Promise<void>;
  children: ReactNode;
}) {
  const { draft, busy, armed, setArmed } = model;
  const isArmed = armed?.action === armKey.action && armed.id === armKey.id;
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
  const ready = draft.name.trim() !== "";
  return (
    <form
      aria-label={`Rename ${draft.name || "browser"}`}
      onSubmit={(event) => {
        event.preventDefault();
        void run(() => updateLocalDevice(tomb, draft.id, { name: draft.name }));
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
      <FormCommit label="Save changes" disabled={busy || !ready}>
        <IconKey label="Cancel" disabled={busy} onClick={() => setDraft(null)}>
          <IconX size={16} />
        </IconKey>
      </FormCommit>
    </form>
  );
}
