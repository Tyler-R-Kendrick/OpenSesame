import { generate } from "@opensesame/app-core/lib/vault/password.js";
import { type ReactNode, useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey } from "../../components/IconKey.js";
import { IconCheck, IconRefresh, IconX } from "../../components/Icons.js";

function generatedSecret(): string {
  return generate({
    mode: "characters",
    length: 32,
    lower: true,
    upper: true,
    digits: true,
    symbols: true,
    avoidAmbiguous: true,
  });
}

function UpdateEditor({
  label,
  mode,
  value,
  busy,
  onMode,
  onValue,
  onApply,
  onCancel,
}: {
  label: string;
  mode: "generate" | "provide";
  value: string;
  busy: boolean;
  onMode: (mode: "generate" | "provide") => void;
  onValue: (value: string) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="detail__update">
      <fieldset className="sites-effect-toggle" aria-label="Update mode">
        <button
          type="button"
          className={
            mode === "generate" ? "sites-effect is-on is-allow" : "sites-effect"
          }
          aria-pressed={mode === "generate"}
          onClick={() => onMode("generate")}
        >
          Generate
        </button>
        <button
          type="button"
          className={
            mode === "provide" ? "sites-effect is-on is-allow" : "sites-effect"
          }
          aria-pressed={mode === "provide"}
          onClick={() => onMode("provide")}
        >
          Enter
        </button>
      </fieldset>
      {mode === "provide" ? (
        <input
          type="password"
          className="input"
          autoComplete="new-password"
          placeholder={`New ${label}`}
          aria-label={`New ${label}`}
          value={value}
          onChange={(event) => onValue(event.target.value)}
        />
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="icon-btn is-on"
          disabled={busy}
          aria-busy={busy}
          onClick={onApply}
          aria-label={busy ? "Saving…" : "Save new value"}
          title={busy ? "Saving…" : "Save new value"}
        >
          <IconCheck size={17} />
        </button>
        <IconKey label="Cancel" onClick={onCancel}>
          <IconX size={17} />
        </IconKey>
      </div>
    </div>
  );
}

/**
 * Replace a concealed value. `leading` sits in the same action cluster as
 * the update key; the editor opens beneath that row.
 */
export function UpdateSecretPanel({
  itemId,
  label,
  onUpdate,
  leading,
}: {
  /** The item the secret belongs to: its notice is keyed by item, not field. */
  itemId: string;
  label: string;
  onUpdate: (next: string) => Promise<void>;
  leading?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"generate" | "provide">("generate");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    setError(null);
    setBusy(true);
    try {
      const next = mode === "generate" ? generatedSecret() : value;
      if (!next) throw new Error("Enter a new value.");
      await onUpdate(next);
      setOpen(false);
      setValue("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }

  const failure = (
    <FailureNotice
      id={`vault:secret-update:${itemId}:${label}`}
      title="Password update"
      message={error}
    />
  );
  const trigger = (
    <IconKey label={`Update ${label}`} onClick={() => setOpen(true)}>
      <IconRefresh size={17} />
    </IconKey>
  );
  if (!open) {
    if (!leading) {
      return (
        <>
          {failure}
          {trigger}
        </>
      );
    }
    return (
      <>
        {failure}
        <div className="frow__actions">
          {leading}
          {trigger}
        </div>
      </>
    );
  }

  const editor = (
    <UpdateEditor
      label={label}
      mode={mode}
      value={value}
      busy={busy}
      onMode={setMode}
      onValue={setValue}
      onApply={() => void apply()}
      onCancel={() => {
        setOpen(false);
        setError(null);
      }}
    />
  );
  if (!leading) {
    return (
      <>
        {failure}
        {editor}
      </>
    );
  }
  return (
    <>
      {failure}
      <div className="frow__actions">
        {leading}
        {trigger}
      </div>
      {editor}
    </>
  );
}
