/** The radio-group shape shared by every connector method/config choice. */
import { useId } from "react";

export function ConnectorModes<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  legendHidden = false,
}: {
  label: string;
  value: T;
  options: readonly { id: T; label: string; disabled?: boolean }[];
  onChange: (next: T) => void;
  disabled?: boolean;
  legendHidden?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="cx-block">
      <legend className={legendHidden ? "visually-hidden" : undefined}>
        {label}
      </legend>
      <div className="cx-modes" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <label className="cx-mode" key={option.id}>
            <input
              type="radio"
              name={name}
              checked={value === option.id}
              disabled={disabled || option.disabled}
              onChange={() => onChange(option.id)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
