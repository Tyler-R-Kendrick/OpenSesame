/**
 * The environment switch: one tab per environment, and a name field to add
 * another. With none yet, the three most common are one press each, so a
 * vault starts with environments without typing anything.
 */

import { type FormEvent, type KeyboardEvent, useRef, useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconPlus, IconTrash } from "../../components/Icons.js";
import { useArmed } from "./use-armed.js";

const STARTERS = ["development", "staging", "production"] as const;

type TabsProps = Readonly<{
  names: readonly string[];
  active: string | null;
  onChoose: (name: string) => void;
  onAdd: (typed: string) => Promise<boolean>;
  onRemove: (name: string) => void;
  /** True when the last add was refused, so the field can say so. */
  invalid: boolean;
}>;

function Starters({ onAdd }: Pick<TabsProps, "onAdd">) {
  return (
    <fieldset className="env__starters">
      <legend className="visually-hidden">Start with</legend>
      {STARTERS.map((name) => (
        <button
          key={name}
          type="button"
          className="env__choice"
          onClick={() => {
            void onAdd(name);
          }}
        >
          {name}
        </button>
      ))}
    </fieldset>
  );
}

/** Arrow keys, Home and End move between tabs as a tablist does. */
function nextTab(event: KeyboardEvent, at: number, count: number) {
  const step =
    event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  const edge =
    event.key === "Home" ? 0 : event.key === "End" ? count - 1 : null;
  if (step === 0 && edge === null) return null;
  return edge ?? (at + step + count) % count;
}

function Tablist({
  names,
  active,
  onChoose,
}: Pick<TabsProps, "names" | "active" | "onChoose">) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (event: KeyboardEvent, at: number) => {
    const next = nextTab(event, at, names.length);
    const name = next === null ? undefined : names[next];
    if (next === null || name === undefined) return;
    event.preventDefault();
    onChoose(name);
    refs.current[next]?.focus();
  };
  return (
    <div className="env__tablist" role="tablist" aria-label="Environment">
      {names.map((name, at) => (
        <button
          key={name}
          ref={(node) => {
            refs.current[at] = node;
          }}
          type="button"
          role="tab"
          id={`env-tab-${name}`}
          aria-selected={active === name}
          aria-controls="env-panel"
          tabIndex={active === name ? 0 : -1}
          className={`env__tab${active === name ? " is-active" : ""}`}
          onClick={() => onChoose(name)}
          onKeyDown={(event) => move(event, at)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

/** Removes the environment in view and every value in it, after a second press. */
function RemoveKey({
  active,
  onRemove,
}: Pick<TabsProps, "onRemove"> & { active: string }) {
  const [armed, press] = useArmed(() => onRemove(active));
  return (
    <IconKey
      label={
        armed
          ? `Press again to remove ${active} and its values`
          : `Remove ${active}`
      }
      armed={armed}
      onClick={press}
    >
      <IconTrash size={17} />
    </IconKey>
  );
}

function AddForm({ onAdd, invalid }: Pick<TabsProps, "onAdd" | "invalid">) {
  const [typed, setTyped] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (typed.trim() === "") return;
    if (await onAdd(typed)) setTyped("");
  };
  return (
    <form className="keyed-row env__new" onSubmit={submit}>
      <input
        className="env__input"
        autoComplete="off"
        spellCheck={false}
        maxLength={32}
        placeholder="qa"
        aria-label="New environment"
        aria-invalid={invalid || undefined}
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
      />
      <IconKey label="Add environment" type="submit">
        <IconPlus size={17} />
      </IconKey>
    </form>
  );
}

export function EnvironmentTabs({
  names,
  active,
  onChoose,
  onAdd,
  onRemove,
  invalid,
}: TabsProps) {
  return (
    <div className="env__switch">
      <div className="env__tabrow">
        {names.length === 0 ? (
          <Starters onAdd={onAdd} />
        ) : (
          <Tablist names={names} active={active} onChoose={onChoose} />
        )}
        {active === null ? null : (
          <RemoveKey active={active} onRemove={onRemove} />
        )}
      </div>
      <AddForm onAdd={onAdd} invalid={invalid} />
    </div>
  );
}
