import {
  MACRO_PREFIX,
  SECTION_PREFIX,
} from "@opensesame/app-core/lib/keymap/commands.js";
import {
  type KeymapConfig,
  type KeymapEvent,
  type Macro,
  type MacroStep,
  enterEvent,
  stepProblem,
} from "@opensesame/app-core/lib/keymap/config.js";
import { retargetKeys } from "@opensesame/app-core/lib/keymap/effective.js";
import { ownMacro } from "@opensesame/app-core/lib/keymap/macros.js";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconTrash, IconX } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { MacroSteps } from "./MacroSteps.js";
import type { KeymapState } from "./useKeymap.js";

const NAME = /^[a-z][a-z0-9-]{0,23}$/;

/** The events a macro may run on: unlock, and opening each section. */
export function macroEvents(state: KeymapState) {
  return [
    { id: "unlock" as const, label: "the vault unlocks" },
    ...state.commands
      .filter((command) => command.id.startsWith(SECTION_PREFIX))
      .map((command) => ({
        id: enterEvent(command.id.slice(SECTION_PREFIX.length)),
        label: `${command.label} opens`,
      })),
  ];
}

/** The keymap with `name` written (and renamed from `was`), keys moved. */
function withMacro(
  config: KeymapConfig,
  was: string | undefined,
  name: string,
  macro: Macro,
): KeymapConfig {
  const macros = { ...config.macros };
  if (was !== undefined) delete macros[was];
  macros[name] = macro;
  const moved =
    was === undefined
      ? config
      : retargetKeys(config, `${MACRO_PREFIX}${was}`, `${MACRO_PREFIX}${name}`);
  return { ...moved, macros };
}

/** The keymap without `name`, and without a key left bound to it anywhere. */
function withoutMacro(config: KeymapConfig, name: string): KeymapConfig {
  const macros = { ...config.macros };
  delete macros[name];
  return { ...retargetKeys(config, `${MACRO_PREFIX}${name}`, null), macros };
}

function nameProblemOf(
  name: string,
  was: string | undefined,
  state: KeymapState,
): string | null {
  if (!NAME.test(name)) return "A name is lowercase letters, digits and dashes";
  if (name !== was && ownMacro(state.config.macros, name) !== undefined)
    return `There is already a macro named ${name}`;
  return null;
}

function NameRow({
  id,
  name,
  problem,
  onName,
}: {
  id: string;
  name: string;
  problem: string | null;
  onName: (name: string) => void;
}) {
  const shown = name !== "" && problem !== null;
  // The key that opened the editor is gone while it is open: focus starts in it.
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
  }, []);
  return (
    <div className="kb-editor__row">
      <label htmlFor={`macro-name-${id}`}>Name</label>
      <span className="kb-editor__value">
        <span className="kb-editor__at" aria-hidden="true">
          @
        </span>
        <input
          id={`macro-name-${id}`}
          ref={field}
          value={name}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={shown ? true : undefined}
          onChange={(event) => onName(event.target.value.toLowerCase())}
        />
        {shown ? <StatusMark tone="err" label={problem} /> : null}
      </span>
    </div>
  );
}

function TriggerRow({
  id,
  on,
  events,
  onOn,
}: {
  id: string;
  on: KeymapEvent | undefined;
  events: readonly { id: KeymapEvent; label: string }[];
  onOn: (on: KeymapEvent | undefined) => void;
}) {
  return (
    <div className="kb-editor__row">
      <label htmlFor={`macro-on-${id}`}>Runs when</label>
      <select
        id={`macro-on-${id}`}
        value={on ?? ""}
        onChange={(event) =>
          onOn(events.find((item) => item.id === event.target.value)?.id)
        }
      >
        <option value="">its keys are pressed</option>
        {events.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Delete asks twice, re-labelled in place, like every destructive key. */
function DeleteMacro({
  name,
  onDelete,
}: {
  name: string;
  onDelete: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const label = armed ? `Press again to delete @${name}` : `Delete @${name}`;
  return (
    <button
      type="button"
      className={`icon-btn${armed ? " is-armed" : ""}`}
      aria-label={label}
      title={label}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (armed) onDelete();
        else setArmed(true);
      }}
    >
      <IconTrash size={16} />
    </button>
  );
}

/**
 * One macro, as a record being filled in: its name, what it runs on, and its
 * steps. Saved whole with the `.go` key; a macro that would do from an event
 * what only a person should is refused step by step, before it is saved.
 */
export function MacroEditor({
  name: was,
  macro,
  state,
  onDone,
}: {
  name?: string;
  macro?: Macro;
  state: KeymapState;
  onDone: (saved: string | null) => void;
}) {
  const id = was ?? "new";
  const [name, setName] = useState(was ?? "");
  const [on, setOn] = useState<KeymapEvent | undefined>(macro?.on);
  const [steps, setSteps] = useState<MacroStep[]>([...(macro?.steps ?? [])]);
  const [refused, setRefused] = useState<string | null>(null);
  const nameProblem = nameProblemOf(name, was, state);
  const blocked =
    nameProblem !== null ||
    steps.length === 0 ||
    steps.some((step) => stepProblem(step, on, state.commands) !== null);

  const save = (next: KeymapConfig, saved: string | null) => {
    const problem = state.save(next);
    if (problem) setRefused(problem);
    else onDone(saved);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (blocked) return;
    const body: Macro = on ? { steps, on } : { steps };
    save(withMacro(state.config, was, name, body), name);
  };

  return (
    <form
      className="kb-editor"
      onSubmit={submit}
      aria-label={was ? `Edit @${was}` : "New macro"}
    >
      <NameRow id={id} name={name} problem={nameProblem} onName={setName} />
      <TriggerRow id={id} on={on} events={macroEvents(state)} onOn={setOn} />
      <div className="kb-editor__row kb-editor__row--steps">
        <span className="kb-editor__label">Steps</span>
        <MacroSteps steps={steps} on={on} state={state} onChange={setSteps} />
      </div>
      <FormCommit label="Save macro" disabled={blocked}>
        <button
          type="button"
          className="icon-btn"
          aria-label="Cancel"
          title="Cancel"
          data-pane-close=""
          onClick={() => onDone(null)}
        >
          <IconX size={16} />
        </button>
        {was !== undefined ? (
          <DeleteMacro
            name={was}
            onDelete={() => save(withoutMacro(state.config, was), null)}
          />
        ) : null}
        {refused ? <StatusMark tone="err" label={refused} /> : null}
      </FormCommit>
    </form>
  );
}
