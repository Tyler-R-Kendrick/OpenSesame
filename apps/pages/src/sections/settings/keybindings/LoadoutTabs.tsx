import {
  LOADOUTS,
  type Loadout,
} from "@opensesame/app-core/lib/keymap/gestures.js";
import { type KeyboardEvent, useRef } from "react";

/** The tab and the panel it draws, named once so the two cannot drift. */
export const loadoutTabId = (id: Loadout) => `kb-tab-${id}`;
export const loadoutPanelId = (id: Loadout) => `kb-loadout-${id}`;

/**
 * Keyboard and Gestures: the two loadouts of one keymap (ADR 0167), as tabs.
 * Arrow keys, Home and End move between them as a tablist does; the device's
 * own loadout is the one a person lands on, never the only one drawn.
 */
export function LoadoutTabs({
  selected,
  onSelect,
}: {
  selected: Loadout;
  onSelect: (loadout: Loadout) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (event: KeyboardEvent, at: number) => {
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const edge =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? LOADOUTS.length - 1
          : null;
    if (step === 0 && edge === null) return;
    event.preventDefault();
    const next = edge ?? (at + step + LOADOUTS.length) % LOADOUTS.length;
    const loadout = LOADOUTS[next];
    if (!loadout) return;
    onSelect(loadout.id);
    refs.current[next]?.focus();
  };
  return (
    <div className="kb-tabs" role="tablist" aria-label="Input loadout">
      {LOADOUTS.map((loadout, at) => (
        <button
          key={loadout.id}
          ref={(node) => {
            refs.current[at] = node;
          }}
          type="button"
          role="tab"
          id={loadoutTabId(loadout.id)}
          aria-controls={loadoutPanelId(loadout.id)}
          aria-selected={selected === loadout.id}
          tabIndex={selected === loadout.id ? 0 : -1}
          className={`kb-tab${selected === loadout.id ? " is-active" : ""}`}
          data-loadout={loadout.id}
          onClick={() => onSelect(loadout.id)}
          onKeyDown={(event) => move(event, at)}
        >
          {loadout.label}
        </button>
      ))}
    </div>
  );
}
