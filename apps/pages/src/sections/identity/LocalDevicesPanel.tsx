import { kvDurability } from "@opensesame/app-core/lib/kv.js";
import {
  type LocalDevice,
  readLocalDevices,
  thisDeviceId,
  touchThisDevice,
} from "@opensesame/app-core/lib/local-devices.js";
import { subscribeLocalIamChanges } from "@opensesame/app-core/lib/local-iam-events.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconKey, ReloadKey } from "../../components/IconKey.js";
import { IconPlus } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import {
  type DeviceDraft,
  DeviceForm,
  DeviceRows,
  type DevicesModel,
  NEW_DEVICE_KEY_ID,
  newDeviceDraft,
} from "./LocalDeviceRows.js";
import { useFocusAfter } from "./use-focus-after.js";

const READ_ERROR =
  "Could not read devices from this vault. Unlock it and reload; restore a backup if the problem persists.";

/**
 * Identity › Devices for this vault: the same commands as every other
 * Identity list — register one, reload, edit, remove behind an armed key —
 * over the device inventory (`local-devices.ts`).
 */
export function LocalDevicesPanel({ tomb }: { tomb: string }) {
  const model = useDevices(tomb);
  const { devices, draft, setDraft, busy, error, load } = model;
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
          <ReloadKey
            label="Reload devices"
            disabled={busy}
            onReload={() => load(true)}
          />
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
          {devices && devices.length > 0 && !listsThisBrowser(devices) ? (
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

function useDevices(tomb: string): DevicesModel & {
  load: (clearError: boolean) => void;
} {
  const [devices, setDevices] = useState<LocalDevice[] | null>(null);
  const [draft, setDraft] = useState<DeviceDraft | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);

  const focusAfter = useFocusAfter(busy);

  const read = useCallback(
    async (clearError: boolean) => {
      const current = ++generation.current;
      // An invalidation from elsewhere must not wipe an alert the person is
      // still reading; the explicit reload and the first read may.
      if (clearError) setError("");
      try {
        const next = await readLocalDevices(tomb);
        if (current !== generation.current) return;
        setDevices(next);
        // An armed key whose device left stays armed for nothing.
        setArmed((key) =>
          key && next.some((row) => key.endsWith(`:${row.id}`)) ? key : null,
        );
      } catch {
        if (current === generation.current) setError(READ_ERROR);
      }
    },
    [tomb],
  );

  // Mark this browser seen once per tomb, then follow changes. The touch is
  // a write that notifies, so it stays out of the subscription: a listener
  // that touched again would re-enter itself forever.
  useEffect(() => {
    let cancelled = false;
    void touchThisDevice(tomb)
      .then((next) => {
        if (cancelled) return;
        generation.current += 1;
        setDevices(next);
        // No error reset: rows drawn by the touch's own notification can be
        // acted on before this lands, and that refusal must stay visible.
      })
      .catch(() => {
        if (!cancelled) setError(READ_ERROR);
      });
    const off = subscribeLocalIamChanges(() => {
      if (!cancelled) void read(false);
    });
    return () => {
      cancelled = true;
      generation.current += 1;
      off();
    };
  }, [tomb, read]);

  async function run(action: () => Promise<LocalDevice[]>, focusId?: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await action();
      generation.current += 1;
      setDevices(next);
      setDraft(null);
      setArmed(null);
      if (focusId) focusAfter(focusId);
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
    devices,
    draft,
    setDraft,
    armed,
    setArmed,
    busy,
    error,
    run,
    load: (clearError) => void read(clearError),
  };
}
