import { FailureNotice } from "../../components/FailureNotice.js";
import { StatusMark } from "../../components/StatusMark.js";

/** A labelled switch: one setting a person turns on or off. */
export function SwitchRow({
  id,
  label,
  on,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  on: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="tailnet-switch">
      <span id={`${id}-label`}>{label}</span>
      <button
        id={id}
        type="button"
        className="toggle"
        role="switch"
        aria-checked={on}
        aria-labelledby={`${id}-label`}
        disabled={disabled}
        onClick={() => onChange(!on)}
      />
    </div>
  );
}

/**
 * What the daemon or Tailscale refused, inside a sheet. The sheet is modal, so
 * the bell is out of reach while it is open: the sentence is the mark's label
 * here and also a notice in the tray (ADR 0163 § Modal ceremonies). One sheet is
 * open at a time, so they share an id.
 */
export function ErrorMark({ error }: { error: string }) {
  return (
    <>
      {error ? (
        <p className="vexport__marks">
          <StatusMark tone="err" label={error} />
        </p>
      ) : null}
      <FailureNotice id="tailnet:devices" title="Tailnet" message={error} />
    </>
  );
}
