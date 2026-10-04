import {
  gestureRows,
  gesturesForgotten,
} from "@opensesame/app-core/lib/keymap/gesture-bindings.js";
import { FIXED_GESTURES } from "@opensesame/app-core/lib/keymap/gestures.js";
import { targetGroups } from "@opensesame/app-core/sections/settings/gesture-panel-model.js";
import { useRef, useState } from "react";
import { IconLock, IconRefresh } from "../../../components/Icons.js";
import { GestureRow } from "./GestureRow.js";
import { MotionSwitch } from "./MotionSwitch.js";
import { Refused } from "./Refused.js";
import type { KeymapState } from "./useKeymap.js";

function FixedGestures() {
  return (
    <section className="kb-group" aria-labelledby="kb-group-fixed-gestures">
      <h3 className="kb-group__label" id="kb-group-fixed-gestures">
        <IconLock size={12} />
        Fixed
      </h3>
      <ul className="kb-rows">
        {FIXED_GESTURES.map(([gesture, label]) => (
          <li key={gesture} className="kb-row kb-row--fixed">
            <span className="kb-row__name">
              <span className="kb-row__label">{gesture}</span>
            </span>
            <span className="kb-row__label">{label}</span>
            <span className="kb-row__end" />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Settings › Keybindings › Gestures (ADR 0164): the touch loadout. One row per
 * gesture a hand may bind, each a choice of what it runs; the gestures that
 * keep the touch road open sit under the lock, as the keyboard's Fixed keys do.
 */
export function GesturesPanel({ state }: { state: KeymapState }) {
  const [met, setMet] = useState<{ message: string; n: number } | null>(null);
  const refusals = useRef(0);
  const rows = gestureRows(state.config);
  const groups = targetGroups(state.config, state.commands);
  const changed =
    rows.some((row) => row.changed) || state.config.motion === false;
  const refuse = (message: string) => {
    refusals.current += 1;
    setMet({ message, n: refusals.current });
  };
  const reset = "Reset every gesture to its default";
  return (
    <section className="panel kb" id="settings-gestures">
      <div className="panel__head">
        <div>
          <h2>Gestures</h2>
        </div>
        <div className="actions">
          {met ? <Refused message={met.message} n={met.n} /> : null}
          {/* With nothing changed there is nothing to forget: no key (ADR 0158). */}
          {changed ? (
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label={reset}
              title={reset}
              data-resets=""
              onClick={() => {
                const refused = state.save(gesturesForgotten(state.config));
                if (refused) refuse(refused);
                else setMet(null);
              }}
            >
              <IconRefresh size={14} />
            </button>
          ) : null}
        </div>
      </div>
      <div className="panel__body">
        <MotionSwitch state={state} />
        <section className="kb-group" aria-labelledby="kb-group-gestures">
          <h3 className="kb-group__label" id="kb-group-gestures">
            Two fingers and the phone
          </h3>
          <ul className="kb-rows">
            {rows.map((row) => (
              <GestureRow
                key={row.id}
                row={row}
                groups={groups}
                state={state}
                onRefused={refuse}
              />
            ))}
          </ul>
        </section>
        <FixedGestures />
      </div>
    </section>
  );
}
