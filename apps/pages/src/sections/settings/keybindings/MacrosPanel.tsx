import {
  MACRO_PREFIX,
  commandById,
} from "@opensesame/app-core/lib/keymap/commands.js";
import {
  type Macro,
  formatStep,
} from "@opensesame/app-core/lib/keymap/config.js";
import {
  keysFor,
  prefixClashes,
} from "@opensesame/app-core/lib/keymap/effective.js";
import { useEffect, useRef, useState } from "react";
import { IconClock, IconEdit, IconPlus } from "../../../components/Icons.js";
import { BoundKeys } from "./BoundKeys.js";
import { MacroEditor, macroEvents } from "./MacroEditor.js";
import type { KeymapState } from "./useKeymap.js";

/** `listing.search → 3× Next row`, the macro read at a glance. */
function StepsLine({ macro, state }: { macro: Macro; state: KeymapState }) {
  return (
    <span
      className="kb-macro__steps"
      title={macro.steps.map(formatStep).join(", ")}
    >
      {macro.steps.map((step, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional
          key={index}
          className="kb-macro__step"
        >
          {index > 0 ? (
            <span className="kb-macro__then" aria-hidden="true">
              →
            </span>
          ) : null}
          {step.count > 1 ? `${step.count}× ` : ""}
          {commandById(step.command, state.commands)?.label ?? step.command}
        </span>
      ))}
    </span>
  );
}

function MacroRow({
  name,
  macro,
  state,
  editing,
  onEdit,
  onDone,
  waiting,
}: {
  name: string;
  macro: Macro;
  state: KeymapState;
  editing: boolean;
  onEdit: () => void;
  onDone: (saved: string | null) => void;
  waiting: ReadonlySet<string>;
}) {
  const target = `${MACRO_PREFIX}${name}`;
  const keys = keysFor(target, state.config, state.commands, state.scope).map(
    (key) => ({ ...key, waits: waiting.has(key.sequence) }),
  );
  const on = macroEvents(state).find((item) => item.id === macro.on);
  return (
    <li className="kb-row kb-macro" data-macro={name}>
      <span className="kb-row__name">
        <span className="kb-row__label">@{name}</span>
        <StepsLine macro={macro} state={state} />
      </span>
      <BoundKeys target={target} label={`@${name}`} keys={keys} state={state} />
      <span className="kb-row__end">
        {on ? (
          <span
            className="kb-macro__on"
            role="img"
            aria-label={`Runs when ${on.label}`}
            title={`Runs when ${on.label}`}
          >
            <IconClock size={12} />
            {macro.on}
          </span>
        ) : null}
        {/* Its editor is open below: no key to open it again (ADR 0158). */}
        {editing ? null : (
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            data-edit-macro={name}
            aria-label={`Edit @${name}`}
            title={`Edit @${name}`}
            onClick={onEdit}
          >
            <IconEdit size={14} />
          </button>
        )}
      </span>
      {editing ? (
        <MacroEditor name={name} macro={macro} state={state} onDone={onDone} />
      ) : null}
    </li>
  );
}

/**
 * Settings › Keybindings › Macros (ADR 0156): named lists of steps, each run
 * by the keys bound to it — or by an event, vim's autocmd. One opens for
 * editing at a time, in place, never over the page.
 */
export function MacrosPanel({ state }: { state: KeymapState }) {
  // null: none open; "": a new one; a name: that one.
  const [editing, setEditing] = useState<string | null>(null);
  const [land, setLand] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  const macros = Object.entries(state.config.macros).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const waiting = prefixClashes(state.bindings);

  useEffect(() => {
    if (land === null) return;
    const next =
      land === "+"
        ? panel.current?.querySelector<HTMLElement>("[data-new-macro]")
        : [
            ...(panel.current?.querySelectorAll<HTMLElement>(
              "[data-edit-macro]",
            ) ?? []),
          ].find((node) => node.dataset.editMacro === land);
    const idle =
      document.activeElement === null ||
      document.activeElement === document.body ||
      panel.current?.contains(document.activeElement);
    if (idle) next?.focus();
    setLand(null);
  }, [land]);

  const done = (was: string) => (saved: string | null) => {
    setEditing(null);
    setLand(saved ?? (was === "" ? "+" : was));
  };

  return (
    <section className="panel kb" id="settings-macros" ref={panel}>
      <div className="panel__head">
        <div>
          <h2>Macros</h2>
        </div>
        {/* One editor opens at a time: with one open there is no second key. */}
        {editing !== null ? null : (
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            data-new-macro=""
            aria-label="New macro"
            title="New macro"
            onClick={() => setEditing("")}
          >
            <IconPlus size={14} />
          </button>
        )}
      </div>
      <div className="panel__body">
        {editing === "" ? (
          <MacroEditor state={state} onDone={done("")} />
        ) : null}
        {macros.length === 0 && editing !== "" ? (
          <p className="empty">No macros yet.</p>
        ) : null}
        {macros.length > 0 ? (
          <ul className="kb-rows">
            {macros.map(([name, macro]) => (
              <MacroRow
                key={name}
                name={name}
                macro={macro}
                state={state}
                editing={editing === name}
                onEdit={() => setEditing(name)}
                onDone={done(name)}
                waiting={waiting}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
