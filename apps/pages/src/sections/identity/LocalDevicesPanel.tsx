import { kvDurability } from "@opensesame/app-core/lib/kv.js";
import {
  type LocalDevice,
  isDeviceListFull,
  readLocalDevices,
  thisDeviceId,
  touchThisDevice,
} from "@opensesame/app-core/lib/local-devices.js";
import { subscribeLocalIamChanges } from "@opensesame/app-core/lib/local-iam-events.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconKey, ReloadKey } from "../../components/IconKey.js";
import { IconPlus } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { byId, useFocusAfter } from "../../lib/use-focus-after.js";
import {
  type ArmedKey,
  type DeviceDraft,
  DeviceForm,
  DeviceRows,
  type DevicesModel,
  NEW_DEVICE_KEY_ID,
  newDeviceDraft,
} from "./LocalDeviceRows.js";

const READ_ERROR =
  "Could not read devices from this vault. Unlock it and reload; restore a backup if the problem persists.";

/**
 * Identity › Devices for this vault: the same commands as every other
 * Identity list — register one, reload, edit, remove behind an armed key —
 * over the device inventory (`local-devices.ts`).
 */
export function LocalDevicesPanel({ tomb }: { tomb: string }) {
  const model = useDevices(tomb);
  const { devices, draft, setDraft, busy, error, reload } = model;
  return (
    <section className="panel" aria-label="Devices">
      <div className="panel__head">
        <h2>Devices</h2>
        <fieldset className="vtree__keys" aria-label="Device commands">
          <IconKey
            id={NEW_DEVICE_KEY_ID}
            label="New device"
            small
            disabled={busy || !devices || draft !== null}
            onClick={() => setDraft(newDeviceDraft())}
          >
            <IconPlus size={15} />
          </IconKey>
          <ReloadKey label="Reload devices" disabled={busy} onReload={reload} />
        </fieldset>
      </div>
      <div className="panel__body">
        <div className="actions">
          {kvDurability() === "memory" ? (
            <StatusMark
              tone="warn"
              label="Browser storage is unavailable. Changes last only until this tab closes."
            />
          ) : null}
          {error ? (
            <>
              <StatusMark tone="err" label={error} />
              <span role="alert" className="visually-hidden">
                {error}
              </span>
            </>
          ) : null}
          {!devices && !error ? (
            <StatusMark tone="idle" label="Loading devices…" />
          ) : null}
          {devices?.length === 0 ? (
            <StatusMark tone="idle" label="No devices yet." />
          ) : null}
          {devices &&
          isDeviceListFull(devices) &&
          !listsThisBrowser(devices) ? (
            <StatusMark
              tone="warn"
              label="This vault lists as many devices as it can hold, so this browser is not among them. Remove one, then reload."
            />
          ) : null}
        </div>
        <DeviceRows model={model} />
        <DeviceForm model={model} />
      </div>
    </section>
  );
}

function listsThisBrowser(devices: LocalDevice[]): boolean {
  const mine = thisDeviceId();
  return devices.some((device) => device.id === mine);
}

/**
 * The rows, the armed key and the read error, kept consistent: every path
 * that replaces the rows disarms a key whose device left, and a read that
 * lands clears a read error (never a refusal of something the person did).
 */
function useDeviceRows() {
  const [devices, setDevices] = useState<LocalDevice[] | null>(null);
  const [armed, setArmed] = useState<ArmedKey | null>(null);
  const [error, setError] = useState("");
  const showRows = useCallback((next: LocalDevice[]) => {
    setDevices(next);
    setArmed((key) =>
      key && next.some((row) => row.id === key.id) ? key : null,
    );
    setError((current) => (current === READ_ERROR ? "" : current));
  }, []);
  return { devices, armed, setArmed, error, setError, showRows };
}

function useDevices(tomb: string): DevicesModel & { reload: () => void } {
  const rows = useDeviceRows();
  const { showRows, setError, setArmed } = rows;
  const [draft, setDraft] = useState<DeviceDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const focusAfter = useFocusAfter(busy);

  // Load through `load`, and drop a result a later load has overtaken.
  const load = useCallback(
    async (source: () => Promise<LocalDevice[]>) => {
      const current = ++generation.current;
      try {
        const next = await source();
        if (current === generation.current) showRows(next);
      } catch {
        if (current === generation.current) setError(READ_ERROR);
      }
    },
    [showRows, setError],
  );

  // Mark this browser seen once per tomb, then follow changes. The touch is
  // a write that notifies, so it stays out of the subscription: a listener
  // that touched again would re-enter itself forever.
  useEffect(() => {
    let cancelled = false;
    void load(() => touchThisDevice(tomb));
    const off = subscribeLocalIamChanges(() => {
      if (!cancelled) void load(() => readLocalDevices(tomb));
    });
    return () => {
      cancelled = true;
      generation.current += 1;
      off();
    };
  }, [tomb, load]);

  async function run(action: () => Promise<LocalDevice[]>, focusId?: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await action();
      generation.current += 1;
      showRows(next);
      setDraft(null);
      setArmed(null);
      if (focusId) focusAfter(byId(focusId));
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not save this change. Check that the vault is unlocked and browser storage has space, then retry. Your draft has been kept.",
      );
    } finally {
      setBusy(false);
    }
  }

  return {
    tomb,
    devices: rows.devices,
    draft,
    setDraft,
    armed: rows.armed,
    setArmed,
    busy,
    error: rows.error,
    run,
    // The explicit reload clears what is shown and touches again, so a
    // browser left off a full list is listed once a slot has been freed.
    reload: () => {
      setError("");
      void load(() => touchThisDevice(tomb));
    },
  };
}
