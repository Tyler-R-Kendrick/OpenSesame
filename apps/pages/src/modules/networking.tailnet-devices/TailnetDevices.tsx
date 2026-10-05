/**
 * Identity › Devices, for the tailnet's machines (ADR 0165): the device list
 * the paired daemon reads from Tailscale, its auth keys and what was changed,
 * with the keys a pairing's role allows. With no daemon paired the panel
 * offers pairing and nothing else.
 */

import type { TailnetAdmin } from "@opensesame/app-core/lib/tailnet-admin/client.js";
import {
  DEVICE_FILTERS,
  type DeviceFilter,
  needsAttention,
  visibleDevices,
} from "@opensesame/app-core/lib/tailnet-admin/model.js";
import type { TailnetDevice } from "@opensesame/app-core/lib/tailnet-admin/wire.js";
import { useEffect, useState } from "react";
import { IconKey, ReloadKey } from "../../components/IconKey.js";
import {
  IconConnection,
  IconPlus,
  IconSignOut,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import {
  subscribeLinkedTailnetPairing,
  takeLinkedTailnetPairing,
} from "../../lib/pairing-link.js";
import { ActivityPanel } from "./ActivityPanel.js";
import { AddDeviceSheet } from "./AddDeviceSheet.js";
import { ArmedKey } from "./ArmedKey.js";
import { ADD_DEVICE_KEY_ID, DeviceRow } from "./DeviceRow.js";
import { DeviceSheet } from "./DeviceSheet.js";
import { KeysPanel } from "./KeysPanel.js";
import { PairSheet } from "./PairSheet.js";
import { type TailnetModel, useTailnetAdmin } from "./use-tailnet-admin.js";
import "./tailnet-devices.css";

export const PAIR_KEY_ID = "tailnet-pair";

function count(
  devices: readonly TailnetDevice[],
  filter: DeviceFilter,
  now: number,
): number {
  if (filter === "attention")
    return devices.filter((d) => needsAttention(d, now)).length;
  if (filter === "online") return devices.filter((d) => d.connected).length;
  if (filter === "offline") return devices.filter((d) => !d.connected).length;
  return devices.length;
}

function Marks({ model }: { model: TailnetModel }) {
  const { target, loaded, error, admin } = model;
  return (
    <div className="actions">
      {error ? (
        <>
          <StatusMark tone="err" label={error} />
          <span role="alert" className="visually-hidden">
            {error}
          </span>
        </>
      ) : null}
      {target ? null : (
        <StatusMark
          tone="idle"
          label={
            admin.canPair()
              ? "No daemon paired for device management."
              : "Unlock a vault you own to pair a daemon."
          }
        />
      )}
      {target && !loaded && !error ? (
        <StatusMark tone="idle" label="Reading the tailnet…" />
      ) : null}
      {loaded && !loaded.status.connected ? (
        <StatusMark tone="warn" label="The daemon has no tailnet connected." />
      ) : null}
      {target && loaded ? (
        <span className="identity-row__when">
          {[
            loaded.status.tailnet === "-" ? "" : loaded.status.tailnet,
            target.label,
            target.host,
            target.role,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      ) : null}
    </div>
  );
}

function HeadKeys({
  model,
  onAdd,
  onPair,
}: {
  model: TailnetModel;
  onAdd: () => void;
  onPair: () => void;
}) {
  const { target, loaded, busy, canManage } = model;
  if (!target)
    return (
      <fieldset className="vtree__keys" aria-label="Tailnet device commands">
        <IconKey
          id={PAIR_KEY_ID}
          label="Pair with the tailnet daemon"
          small
          disabled={!model.admin.canPair()}
          onClick={onPair}
        >
          <IconConnection size={15} />
        </IconKey>
      </fieldset>
    );
  return (
    <fieldset className="vtree__keys" aria-label="Tailnet device commands">
      {canManage ? (
        <IconKey
          id={ADD_DEVICE_KEY_ID}
          label="Add a device"
          small
          disabled={busy || !loaded?.status.connected}
          onClick={onAdd}
        >
          <IconPlus size={15} />
        </IconKey>
      ) : null}
      <ReloadKey
        label="Reload tailnet devices"
        disabled={busy}
        onReload={model.reload}
      />
      <ArmedKey
        model={model}
        arm={{ action: "forget", id: "pairing" }}
        label="Forget this daemon's pairing"
        confirmLabel="Confirm forgetting this daemon's pairing"
        keepLabel="Keep this daemon's pairing"
        onConfirm={() => void model.run(() => model.admin.forget())}
      >
        <IconSignOut size={15} />
      </ArmedKey>
    </fieldset>
  );
}

function Filters({
  devices,
  filter,
  now,
  onFilter,
}: {
  devices: readonly TailnetDevice[];
  filter: DeviceFilter;
  now: number;
  onFilter: (filter: DeviceFilter) => void;
}) {
  return (
    <div
      className="tailnet-choices"
      role="radiogroup"
      aria-label="Show devices"
    >
      {DEVICE_FILTERS.map((choice) => (
        <button
          key={choice.id}
          type="button"
          className="tailnet-choice"
          aria-pressed={filter === choice.id}
          onClick={() => onFilter(choice.id)}
        >
          {choice.label} {count(devices, choice.id, now)}
        </button>
      ))}
    </div>
  );
}

/** A pairing link opened in this tab, or one opened while the page was up. */
function useLinkedPairing(onCode: (code: string) => void) {
  useEffect(() => {
    const take = () => {
      const linked = takeLinkedTailnetPairing();
      if (linked) onCode(linked);
    };
    take();
    return subscribeLinkedTailnetPairing(take);
  }, [onCode]);
}

export function TailnetDevices({ admin }: { admin: TailnetAdmin }) {
  const model = useTailnetAdmin(admin);
  const [filter, setFilter] = useState<DeviceFilter>("all");
  const [editing, setEditing] = useState<TailnetDevice | null>(null);
  const [adding, setAdding] = useState(false);
  const [pairCode, setPairCode] = useState<string | null>(null);

  useLinkedPairing(setPairCode);

  const loaded = model.loaded;
  const now = loaded?.at ?? Date.now();
  const devices = loaded ? visibleDevices(loaded.devices, filter, "", now) : [];
  return (
    <>
      <section className="panel" aria-label="Tailnet devices">
        <div className="panel__head">
          <h2>Tailnet devices</h2>
          <HeadKeys
            model={model}
            onAdd={() => setAdding(true)}
            onPair={() => setPairCode("")}
          />
        </div>
        <div className="panel__body">
          <Marks model={model} />
          {loaded && loaded.devices.length > 0 ? (
            <Filters
              devices={loaded.devices}
              filter={filter}
              now={now}
              onFilter={setFilter}
            />
          ) : null}
          {loaded && devices.length === 0 ? (
            <div className="actions">
              <StatusMark
                tone="idle"
                label={
                  loaded.devices.length === 0
                    ? "No devices on the tailnet."
                    : "No devices match."
                }
              />
            </div>
          ) : null}
          <ul className="identity-rows">
            {devices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                model={model}
                now={now}
                onEdit={setEditing}
              />
            ))}
          </ul>
        </div>
      </section>
      {loaded ? <KeysPanel model={model} /> : null}
      {loaded ? <ActivityPanel model={model} /> : null}
      {editing ? (
        <DeviceSheet
          device={editing}
          model={model}
          now={now}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {adding ? (
        <AddDeviceSheet
          model={model}
          oauth={loaded?.status.credential === "oauth"}
          onClose={() => setAdding(false)}
        />
      ) : null}
      {pairCode !== null ? (
        <PairSheet
          initialCode={pairCode}
          canPair={admin.canPair()}
          onPair={(code) => admin.pair(code)}
          onClose={() => setPairCode(null)}
        />
      ) : null}
    </>
  );
}
