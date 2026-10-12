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
import { ReloadKey } from "../../components/IconKey.js";
import { StatusMark } from "../../components/StatusMark.js";
import { type FocusTarget, useFocusAfter } from "../../lib/use-focus-after.js";
import {
  type ArmedKey,
  type DeviceDraft,
  DeviceForm,
  DeviceRows,
  type DevicesModel,
} from "./LocalDeviceRows.js";

const READ_ERROR =
  "Could not read devices from this vault. Unlock it and reload; restore a backup if the problem persists.";

/**
 * The browsers that opened this vault (`local-devices.ts`): each lists
 * itself when it unlocks, and may be renamed or removed. The tailnet's real
 * machines are a separate panel, above, when device management is on
 * (ADR 0169).
 */
export function LocalDevicesPanel({ tomb }: { tomb: string }) {
  const model = useDevices(tomb);
  const { devices, busy, error, reload } = model;
  return (
    <section className="panel" aria-label="This vault's browsers">
      <div className="panel__head">
        <h2>Browsers</h2>
        <fieldset className="vtree__keys" aria-label="Browser commands">
          <ReloadKey
            label="Reload browsers"
            disabled={busy}
            onReload={reload}
            keyRef={model.reloadKey}
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
            <StatusMark tone="idle" label="Loading browsers…" />
          ) : null}
          {devices?.length === 0 ? (
            <StatusMark tone="idle" label="No browsers yet." />
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

export function useDevices(
  tomb: string,
  onSaved?: (next: LocalDevice[]) => void,
): DevicesModel & { reload: () => void } {
  const rows = useDeviceRows();
  const { showRows, setError, setArmed } = rows;
  const [draft, setDraft] = useState<DeviceDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const focusAfter = useFocusAfter(busy);
  const reloadKey = useRef<HTMLButtonElement>(null);

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

  async function run(
    action: () => Promise<LocalDevice[]>,
    focus?: FocusTarget,
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await action();
      generation.current += 1;
      showRows(next);
      setDraft(null);
      setArmed(null);
      onSaved?.(next);
      if (focus) focusAfter(focus);
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
    reloadKey,
    // The explicit reload clears what is shown and touches again, so a
    // browser left off a full list is listed once a slot has been freed.
    reload: () => {
      setError("");
      void load(() => touchThisDevice(tomb));
    },
  };
}
