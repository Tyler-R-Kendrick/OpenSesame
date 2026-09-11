import { useEffect, useState } from "react";
import {
  type LocalDevice,
  removeLocalDevice,
  renameLocalDevice,
  thisDeviceId,
  touchThisDevice,
} from "../../lib/local-devices.js";

export function LocalDevicesPanel({ tomb }: { tomb: string }) {
  const [devices, setDevices] = useState<LocalDevice[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<LocalDevice | null>(null);
  const mine = thisDeviceId();

  useEffect(() => {
    let alive = true;
    void touchThisDevice(tomb)
      .then((next) => {
        if (alive) {
          setDevices(next);
          setError("");
        }
      })
      .catch(() => {
        if (alive) setError("Could not read devices from this vault.");
      });
    return () => {
      alive = false;
    };
  }, [tomb]);

  async function run(action: () => Promise<LocalDevice[]>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setDevices(await action());
      setDraft(null);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not update the device list.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-label="Devices">
      <div className="panel__head">
        <h2>Devices</h2>
      </div>
      <div className="panel__body">
        <p className="hint">
          Browsers and installs that have unlocked this vault, not passkeys.
        </p>
        {error ? (
          <p className="note note--err" role="alert">
            {error}
          </p>
        ) : null}
        {!devices && !error ? <output>Loading devices…</output> : null}
        <ul className="identity-rows">
          {devices?.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              mine={mine}
              busy={busy}
              editing={draft !== null}
              onRename={() => setDraft(device)}
              onRemove={() =>
                void run(() => removeLocalDevice(tomb, device.id))
              }
            />
          ))}
        </ul>
        {draft ? (
          <RenameForm
            draft={draft}
            busy={busy}
            onChange={(name) => setDraft({ ...draft, name })}
            onSave={() =>
              void run(() => renameLocalDevice(tomb, draft.id, draft.name))
            }
            onCancel={() => setDraft(null)}
          />
        ) : null}
      </div>
    </section>
  );
}

function DeviceRow({
  device,
  mine,
  busy,
  editing,
  onRename,
  onRemove,
}: {
  device: LocalDevice;
  mine: string;
  busy: boolean;
  editing: boolean;
  onRename: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="identity-row" id={device.id}>
      <div className="identity-row__main">
        <div className="identity-row__id">
          <h3>{device.name}</h3>
          <code className="identity-ref">{device.platform}</code>
        </div>
        {device.id === mine ? (
          <span className="chip">This device</span>
        ) : (
          <span className="chip">{device.platform}</span>
        )}
        <div className="actions">
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy || editing}
            aria-label={`Rename ${device.name}`}
            onClick={onRename}
          >
            Rename
          </button>
          {device.id === mine ? null : (
            <button
              type="button"
              className="btn btn--sm btn--danger"
              disabled={busy || editing}
              aria-label={`Remove ${device.name}`}
              onClick={onRemove}
            >
              Remove
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

function RenameForm({
  draft,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  draft: LocalDevice;
  busy: boolean;
  onChange: (name: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="field">
        <label className="label" htmlFor="local-device-name">
          Name
        </label>
        <input
          id="local-device-name"
          required
          maxLength={128}
          disabled={busy}
          value={draft.name}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      <div className="actions">
        <button
          type="submit"
          className="btn btn--primary"
          disabled={busy || !draft.name.trim()}
        >
          Save name
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
