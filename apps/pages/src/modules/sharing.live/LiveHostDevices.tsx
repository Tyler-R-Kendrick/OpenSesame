/**
 * Devices, from the owner's side of a hosted live session (ADR 0195): a
 * terminal or an agent that was let in and asks to use the connections saved
 * in this app. Each request shows the code the device is showing, so the
 * owner can tell it from any other; allowing it is a choice of connections
 * and a time, and a grant stands until it lapses or is revoked here.
 */

import { allowDevice } from "@opensesame/app-core/lib/live/device-allow.js";
import type { DeviceConnection } from "@opensesame/app-core/lib/live/device-messages.js";
import type {
  ApproveResult,
  DeviceGrant,
  PendingDevice,
} from "@opensesame/app-core/lib/live/device-types.js";
import type {
  HostState,
  LiveHost,
} from "@opensesame/app-core/lib/live/host.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useRef, useState } from "react";
import { CeremonySheet } from "../../components/CeremonySheet.js";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { IconCheck, IconTerminal, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useLandOnChange } from "./live-focus.js";
import {
  type Standing,
  formatRemaining,
  standingMark,
  useRemaining,
} from "./live-hooks.js";
import { DEVICE_DURATIONS, Pick } from "./live-host-form-parts.js";

const REFUSED = {
  approved: null,
  unknown: standingMark("err", "The device has left"),
  lapsed: standingMark("err", "The request lapsed"),
  nothing_chosen: standingMark("warn", "Choose a connection"),
  unavailable: standingMark("err", "Connections are not available"),
} satisfies Record<ApproveResult, Standing | null>;

function AllowSheet({
  host,
  pending,
  onClose,
}: {
  host: LiveHost;
  pending: PendingDevice;
  onClose: () => void;
}) {
  const offered = host.devices?.offered() ?? [];
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [minutes, setMinutes] = useState(60);
  const [said, setSaid] = useState<Standing | null>(null);

  /**
   * Allowing hands out authority, so the vault's own `manage_grants` check
   * runs first (its operator rule and duress ceilings), as it does for any
   * grant; a refusal is a mark on the sheet, and nothing is allowed.
   */
  async function allow(): Promise<void> {
    const approval = { connections: [...chosen], minutes };
    try {
      const result = await allowDevice(
        host.devices,
        vaultStore.activeTomb(),
        pending.id,
        approval,
      );
      const refusal = REFUSED[result];
      if (refusal === null) onClose();
      else setSaid(refusal);
    } catch {
      setSaid(standingMark("err", "Only an operator can allow a device"));
    }
  }

  return (
    <CeremonySheet
      title="Allow a device"
      mark={<IconTerminal size={20} />}
      onClose={onClose}
    >
      <CeremonyShell
        name={pending.name}
        facts={[{ key: "Code", value: pending.userCode }]}
        primary={{
          label: `Allow ${pending.name}`,
          icon: <IconCheck size={18} />,
          disabled: chosen.size === 0,
          onClick: () => void allow(),
        }}
      >
        <fieldset className="live-choose">
          <legend className="visually-hidden">Connections to allow</legend>
          {offered.map((connection) => (
            <label key={connection.id} className="join__choice">
              <input
                type="checkbox"
                checked={chosen.has(connection.id)}
                onChange={(event) => {
                  const next = new Set(chosen);
                  if (event.target.checked) next.add(connection.id);
                  else next.delete(connection.id);
                  setChosen(next);
                  setSaid(null);
                }}
              />
              <span>{connection.label}</span>
            </label>
          ))}
        </fieldset>
        <Pick
          id="live-device-minutes"
          name="For"
          value={minutes}
          options={DEVICE_DURATIONS}
          onChange={setMinutes}
        />
        {said ? <StatusMark tone={said.tone} label={said.label} /> : null}
      </CeremonyShell>
    </CeremonySheet>
  );
}

function PendingRow({
  host,
  pending,
}: {
  host: LiveHost;
  pending: PendingDevice;
}) {
  const [allowing, setAllowing] = useState(false);
  return (
    <div className="vault-row">
      <div className="vault-row__body">
        <span className="vault-row__text">
          <span className="vault-row__name">{pending.name}</span>
          <span className="vault-row__meta live-code">{pending.userCode}</span>
        </span>
        <StatusMark tone="warn" label="Asking to use your connections" />
      </div>
      <button
        type="button"
        className="icon-btn"
        aria-label={`Allow ${pending.name}`}
        title={`Allow ${pending.name}`}
        onClick={() => setAllowing(true)}
      >
        <IconCheck size={16} />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label={`Turn ${pending.name} down`}
        title={`Turn ${pending.name} down`}
        onClick={() => host.devices?.deny(pending.id)}
      >
        <IconX size={16} />
      </button>
      {allowing ? (
        <AllowSheet
          host={host}
          pending={pending}
          onClose={() => setAllowing(false)}
        />
      ) : null}
    </div>
  );
}

function GrantRow({
  host,
  grant,
  offered,
}: {
  host: LiveHost;
  grant: DeviceGrant;
  offered: readonly DeviceConnection[];
}) {
  const left = useRemaining(grant.expiresAt);
  const names = grant.connections.map(
    (id) => offered.find((connection) => connection.id === id)?.label ?? id,
  );
  return (
    <div className="vault-row">
      <div className="vault-row__body">
        <span className="vault-row__text">
          <span className="vault-row__name">{grant.name}</span>
          <span className="vault-row__meta">
            {names.join(", ")} · {formatRemaining(left)}
          </span>
        </span>
        <StatusMark tone="ok" label="Using your connections" />
      </div>
      <button
        type="button"
        className="icon-btn"
        aria-label={`Revoke ${grant.name}`}
        title={`Revoke ${grant.name}`}
        onClick={() => host.devices?.revoke(grant.id)}
      >
        <IconX size={16} />
      </button>
    </div>
  );
}

export function DeviceRequests({
  host,
  state,
}: {
  host: LiveHost;
  state: HostState;
}) {
  const section = useRef<HTMLDivElement>(null);
  const { pending, grants } = state.devices;
  // Allowing or turning a request down takes its row out of the document,
  // and with it the key that held the keyboard.
  useLandOnChange(`${pending.length}:${grants.length}`, () =>
    grants.length > 0
      ? section.current?.querySelector('[aria-label^="Revoke"]')
      : document.getElementById("live-request"),
  );
  if (!host.devices || (pending.length === 0 && grants.length === 0))
    return null;
  const offered = host.devices.offered();
  return (
    <div ref={section} className="setup__stack">
      {pending.map((one) => (
        <PendingRow key={one.id} host={host} pending={one} />
      ))}
      {grants.map((grant) => (
        <GrantRow key={grant.id} host={host} grant={grant} offered={offered} />
      ))}
    </div>
  );
}
