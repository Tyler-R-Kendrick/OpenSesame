import type {
  DuressMode,
  DuressPickRow,
} from "@opensesame/app-core/lib/duress/settings/modes/index.js";
import { useId } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import { PickList } from "./DuressPickList.js";

/**
 * The extra input a mode declares, drawn below the mode radios. Every kind
 * reaches arming as one string (see `DuressModeInput`): a text as typed, a
 * choice as its option's value, items one per line, a pick as the ids of the
 * rows left shown one per line, a confirmation as the word.
 */
export function ModeInput({
  mode,
  busy,
  value,
  onValue,
  rows = [],
}: {
  mode: DuressMode;
  busy: boolean;
  value: string;
  onValue: (next: string) => void;
  /** What a `pick` input offers, from the vault that is open. */
  rows?: readonly DuressPickRow[];
}) {
  const { input } = mode;
  const lines = useId();
  switch (input.kind) {
    case "none":
      return null;
    case "text":
    case "confirm":
      return (
        <FieldShell
          label={input.label}
          value={value}
          onValueChange={onValue}
          autoComplete="off"
          disabled={busy}
          mono={input.kind === "confirm"}
        />
      );
    case "choice":
      return (
        <fieldset className="duress__pick" disabled={busy}>
          <legend className="duress__legend">{input.label}</legend>
          <ul className="duress__choices">
            {input.options.map((option) => (
              <li key={option.value}>
                <label className="duress__choice">
                  <input
                    type="radio"
                    name={`duress-${input.id}`}
                    value={option.value}
                    checked={value === option.value}
                    onChange={() => onValue(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      );
    case "pick":
      return (
        <PickList
          label={input.label}
          rows={rows}
          busy={busy}
          value={value}
          onValue={onValue}
        />
      );
    case "items":
      return (
        <div className="f">
          <div className="f__labelrow">
            <label className="f__label" htmlFor={lines}>
              {input.label}
            </label>
          </div>
          <div className="f__shell">
            <textarea
              id={lines}
              className="f__input duress__lines"
              value={value}
              rows={Math.min(input.max, 8)}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => onValue(event.target.value)}
            />
          </div>
        </div>
      );
  }
}
