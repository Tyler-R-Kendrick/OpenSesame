import type { GestureRow as Row } from "@opensesame/app-core/lib/keymap/gesture-bindings.js";
import {
  bindGesture,
  resetGesture,
} from "@opensesame/app-core/lib/keymap/gesture-bindings.js";
import {
  NO_ACTION,
  type TargetGroup,
  choicesFor,
} from "@opensesame/app-core/sections/settings/gesture-panel-model.js";
import { GestureGlyph } from "../../../components/Icons.gestures.js";
import { IconRefresh } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import type { KeymapState } from "./useKeymap.js";

/**
 * One gesture: its glyph and name over its id, what it runs as a choice, and
 * at the row's end a reset key once it was changed. The choice is the whole
 * edit: a gesture has one action, so there is no keycap to record and no
 * conflict to settle — only "no action" to strike it.
 */
export function GestureRow({
  row,
  groups,
  state,
  onRefused,
}: {
  row: Row;
  groups: readonly TargetGroup[];
  state: KeymapState;
  onRefused: (message: string) => void;
}) {
  const { config, save } = state;
  const choices = choicesFor(row.target, groups);
  const value = row.target ?? NO_ACTION;
  const keep = (next: typeof config) => {
    const refused = save(next);
    if (refused) onRefused(refused);
  };
  const reset = `Reset ${row.label} to its default`;
  return (
    <li
      className="kb-row kb-row--gesture"
      data-gesture={row.id}
      data-changed={row.changed ? "" : undefined}
    >
      <span className="kb-gesture">
        <span className="kb-gesture__glyph">
          <GestureGlyph id={row.id} size={22} />
        </span>
        <span className="kb-row__name">
          <span className="kb-row__label">{row.label}</span>
          <code className="kb-row__id">{row.id}</code>
        </span>
      </span>
      <select
        className="kb-target"
        aria-label={`${row.label} runs`}
        title={`${row.label} runs`}
        value={value}
        onChange={(event) => {
          const picked = event.target.value;
          keep(
            bindGesture(config, row.id, picked === NO_ACTION ? null : picked),
          );
        }}
      >
        <option value={NO_ACTION}>No action</option>
        {choices.map((group) => (
          <optgroup key={group.id} label={group.label}>
            {group.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <span className="kb-row__end">
        {row.off ? (
          <StatusMark tone="idle" label="Motion is off: a shake does nothing" />
        ) : null}
        {row.changed ? (
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label={reset}
            title={reset}
            data-resets=""
            onClick={() => keep(resetGesture(config, row.id))}
          >
            <IconRefresh size={14} />
          </button>
        ) : null}
      </span>
    </li>
  );
}
