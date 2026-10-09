import type { ConfigChoice } from "@opensesame/app-core/lib/self-hosted-config.js";
import { useId } from "react";

/** Native disclosure and checkboxes retain their keyboard behavior. */
export function ConfigSelections({
  label,
  choices,
  selected,
  onChange,
  requiredChoices = [],
}: {
  label: string;
  choices: readonly ConfigChoice[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  requiredChoices?: readonly string[];
}) {
  const id = useId();
  if (choices.length === 0) return null;
  return (
    <details className="cx-selection">
      <summary aria-label={label}>
        <span>{label}</span>
        <span className="cx-selection__count">{selected.length} selected</span>
      </summary>
      <fieldset className="cx-selection__choices">
        <legend className="visually-hidden">{label}</legend>
        {choices.map((choice) => (
          <label className="check" key={choice.name} title={choice.description}>
            <input
              id={`${id}-${choice.name}`}
              type="checkbox"
              checked={selected.includes(choice.name)}
              disabled={requiredChoices.includes(choice.name)}
              onChange={() =>
                onChange(
                  selected.includes(choice.name)
                    ? selected.filter((name) => name !== choice.name)
                    : [...selected, choice.name],
                )
              }
            />
            <span>
              {choice.name}
              {requiredChoices.includes(choice.name) ? " (required)" : ""}
            </span>
          </label>
        ))}
      </fieldset>
    </details>
  );
}
