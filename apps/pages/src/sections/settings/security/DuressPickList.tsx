import {
  type DuressPickRow,
  itemLines,
} from "@opensesame/app-core/lib/duress/settings/modes/index.js";
import "./duress-pick.css";

/**
 * The items of the open vault, each a switch that says whether it is hidden
 * (ADR 0168, drawn like ADR 0165's list: the whole row is the switch). Every
 * row starts hidden; the value is the ids of the rows left shown, one per
 * line, so an id that is missing from it is hidden by construction. A row
 * carries a name and a kind, never a secret.
 */
export function PickList({
  label,
  rows,
  busy,
  value,
  onValue,
}: {
  label: string;
  rows: readonly DuressPickRow[];
  busy: boolean;
  value: string;
  onValue: (next: string) => void;
}) {
  const shown = new Set(itemLines(value));
  const toggle = (id: string) => {
    const next = new Set(shown);
    if (!next.delete(id)) next.add(id);
    onValue(
      rows
        .filter((row) => next.has(row.id))
        .map((row) => row.id)
        .join("\n"),
    );
  };
  const count = rows.filter((row) => shown.has(row.id)).length;
  return (
    <fieldset className="duress__pick" disabled={busy}>
      <legend className="duress__legend">
        {label} · {count} of {rows.length} shown
      </legend>
      <ul className="duress__picks">
        {rows.map((row) => {
          const hidden = !shown.has(row.id);
          return (
            <li key={row.id}>
              <button
                type="button"
                role="switch"
                className="duress__hide"
                aria-checked={hidden}
                aria-label={`Hide ${row.label}`}
                onClick={() => toggle(row.id)}
              >
                <span className="duress__hide-name">{row.label}</span>
                <span className="duress__hide-kind">{row.detail}</span>
                <span className="duress__track" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
