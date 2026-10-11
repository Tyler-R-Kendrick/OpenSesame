/**
 * The small controls the owner's forms are made of: a row of choices whose
 * words are the thing chosen, a switch, and the mark a field carries when its
 * draft is not finished. A mark here is not a failure: nothing was tried.
 */

import { useId } from "react";
import { StatusMark } from "../../../components/StatusMark.js";

export type Choice<T extends string | number> = Readonly<{
  value: T;
  label: string;
}>;

/** One mark for a field that is not right yet; nothing when it is. */
export function FieldMark({ message }: { message: string | null }) {
  return message ? <StatusMark tone="err" label={message} /> : null;
}

/** A labelled row of choices; exactly one is pressed. */
export function Choices<T extends string | number>({
  label,
  options,
  value,
  onChange,
  message = null,
}: {
  label: string;
  options: readonly Choice<T>[];
  value: T;
  onChange: (next: T) => void;
  message?: string | null;
}) {
  const id = useId();
  return (
    <div className="f">
      <div className="f__labelrow">
        <span className="f__label" id={id}>
          {label}
        </span>
        <FieldMark message={message} />
      </div>
      <div className="tcc-choices" role="radiogroup" aria-labelledby={id}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className="tcc-choice"
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A switch with its words beside it. */
export function SwitchRow({
  id,
  label,
  on,
  onChange,
  disabled = false,
}: {
  id: string;
  label: string;
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="tcc-switch">
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

/** A labelled list to pick one from, for lists that can run long. */
export function PickField({
  id,
  label,
  value,
  options,
  onChange,
  message = null,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly Choice<string>[];
  onChange: (next: string) => void;
  message?: string | null;
}) {
  return (
    <div className="f">
      <div className="f__labelrow">
        <label className="f__label" htmlFor={id}>
          {label}
        </label>
        <FieldMark message={message} />
      </div>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
