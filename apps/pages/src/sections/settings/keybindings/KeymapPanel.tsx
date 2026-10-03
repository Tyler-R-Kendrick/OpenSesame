import { FIXED_ROWS } from "@opensesame/app-core/lib/keymap/commands.js";
import type { KeymapConfig } from "@opensesame/app-core/lib/keymap/config.js";
import { resetTarget } from "@opensesame/app-core/lib/keymap/effective.js";
import { keycapLabel } from "@opensesame/app-core/lib/keymap/notation.js";
import { resetKeymap } from "@opensesame/app-core/lib/keymap/store.js";
import {
  KEYMAP_FILTERS,
  KEYMAP_SCOPES,
  type KeymapFilter,
  type KeymapRow,
  type KeymapScope,
  changedCount,
  keymapGroups,
  unavailableBindings,
} from "@opensesame/app-core/sections/settings/keymap-panel-model.js";
import { useRef, useState } from "react";
import { IconLock, IconRefresh } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { BoundKeys } from "./BoundKeys.js";
import { CommandCount } from "./CommandCount.js";
import { KeymapFind } from "./KeymapFind.js";
import { Refused } from "./Refused.js";
import { UnavailableKeys } from "./UnavailableKeys.js";
import { useFocusLanding } from "./useFocusLanding.js";
import type { KeymapState } from "./useKeymap.js";

/** The filter choice in the head: where focus goes when a row is gone. */
const FILTER_LANDING = '[data-land="filter"]';

type Land = (selectors: readonly string[]) => void;

function Row({
  row,
  state,
  onLand,
}: {
  row: KeymapRow;
  state: KeymapState;
  onLand: Land;
}) {
  const { command } = row;
  return (
    <li
      className="kb-row"
      data-command={command.id}
      data-changed={row.changed ? "" : undefined}
    >
      <span className="kb-row__name">
        <span className="kb-row__label">{command.label}</span>
        <code className="kb-row__id">{command.id}</code>
      </span>
      <BoundKeys
        target={command.id}
        label={command.label}
        keys={row.keys}
        locked={row.locked}
        state={state}
      />
      <span className="kb-row__end">
        {row.locked ? (
          <StatusMark
            tone="idle"
            label="Asks before it acts: no key can be moved onto it"
          />
        ) : null}
        {row.changed ? (
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label={`Reset ${command.label} to its default keys`}
            title={`Reset ${command.label} to its default keys`}
            data-resets=""
            onClick={() => {
              state.save(
                resetTarget(
                  state.config,
                  state.commands,
                  command.id,
                  state.scope,
                ),
              );
              onLand([
                `[data-command="${command.id}"] [data-add-key]`,
                FILTER_LANDING,
              ]);
            }}
          >
            <IconRefresh size={14} />
          </button>
        ) : null}
      </span>
    </li>
  );
}

/** A fixed key as its keycap reads: the Menu key is a glyph name, the rest are as spelled. */
function fixedKeycap(key: string): string {
  return key === "ContextMenu"
    ? keycapLabel(key)
    : key.replace("Shift+", "Shift-");
}

function FixedKeys() {
  return (
    <section className="kb-group" aria-labelledby="kb-group-fixed">
      <h3 className="kb-group__label" id="kb-group-fixed">
        <IconLock size={12} />
        Fixed
      </h3>
      <ul className="kb-rows">
        {FIXED_ROWS.map(([keys, label]) => (
          <li key={keys} className="kb-row kb-row--fixed">
            <span className="kb-row__name">
              <span className="kb-row__label">{label}</span>
            </span>
            <span className="kb-keys">
              {keys.split(" / ").map((key) => (
                <span key={key} className="keycap-btn keycap-btn--fixed">
                  <kbd className="keycap">{fixedKeycap(key)}</kbd>
                </span>
              ))}
            </span>
            <span className="kb-row__end" />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ResetAll({ state, onLand }: { state: KeymapState; onLand: Land }) {
  const [armed, setArmed] = useState(false);
  // A refusal is about the keymap it met: once the keymap changes (a later
  // edit, another tab) it no longer describes anything on screen.
  const [met, setMet] = useState<{
    message: string;
    n: number;
    config: KeymapConfig;
  } | null>(null);
  const refusals = useRef(0);
  const refused = met !== null && met.config === state.config ? met : null;
  const changed =
    changedCount(state.config, state.commands) +
    Object.keys(state.config.macros).length;
  const pristine = changed === 0 && state.config.singleKeys;
  const label = armed
    ? "Press again to forget every change and macro"
    : "Reset every key and macro";
  return (
    <>
      {refused ? <Refused message={refused.message} n={refused.n} /> : null}
      {/* With nothing changed there is nothing to forget: no key (ADR 0158). */}
      {pristine ? null : (
        <button
          type="button"
          className={`icon-btn icon-btn--sm${armed ? " is-armed" : ""}`}
          aria-label={label}
          title={label}
          aria-pressed={armed}
          data-resets=""
          onBlur={() => setArmed(false)}
          onClick={() => {
            if (!armed) {
              setMet(null);
              setArmed(true);
              return;
            }
            const reset = resetKeymap();
            setArmed(false);
            if (!reset.ok) {
              refusals.current += 1;
              setMet({
                message: reset.message,
                n: refusals.current,
                config: state.config,
              });
              return;
            }
            setMet(null);
            onLand([FILTER_LANDING]);
          }}
        >
          <IconRefresh size={14} />
        </button>
      )}
    </>
  );
}

function CharacterKeys({ state }: { state: KeymapState }) {
  const on = state.config.singleKeys;
  const label = "Single-character keys run commands";
  return (
    <div className="sw kb-single">
      <span className="sw__name">Single-character keys</span>
      <button
        type="button"
        className="toggle"
        role="switch"
        aria-checked={on}
        aria-label={label}
        title={
          on ? label : "Off: only Control, arrows and named keys run commands"
        }
        onClick={() => state.save({ ...state.config, singleKeys: !on })}
      />
    </div>
  );
}

/** A short choice in the panel head, sized to its options. */
function HeadChoice<T extends string>({
  label,
  land,
  value,
  options,
  onChange,
}: {
  label: string;
  /** Marks the choice as a place focus may land. */
  land?: string;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <select
      className="head-filter"
      aria-label={label}
      title={label}
      data-land={land}
      value={value}
      onChange={(event) => {
        const picked = options.find((item) => item.id === event.target.value);
        if (picked) onChange(picked.id);
      }}
    >
      {options.map((item) => (
        <option key={item.id} value={item.id}>
          {item.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Settings › Keybindings › Keymap (ADR 0156): every command, its keys as
 * keycaps, found by words or by pressing the keys themselves — everywhere,
 * or as they hold in one listing (§6).
 */
export function KeymapPanel({
  state,
  scope,
  onScope,
}: {
  /** The keymap as it holds in `scope`. */
  state: KeymapState;
  scope: KeymapScope;
  onScope: (scope: KeymapScope) => void;
}) {
  const [query, setQuery] = useState("");
  const [recorded, setRecorded] = useState<string | null>(null);
  const [filter, setFilter] = useState<KeymapFilter>("all");
  const panel = useRef<HTMLElement>(null);
  const land = useFocusLanding(panel);
  const groups = keymapGroups(state.config, state.commands, {
    query,
    recorded,
    filter,
    scope,
  });
  const whole = query === "" && recorded === null;
  const shown = groups.reduce((sum, group) => sum + group.rows.length, 0);
  return (
    <section className="panel kb" id="settings-keymap" ref={panel}>
      <div className="panel__head">
        <div>
          <h2>Keymap</h2>
        </div>
        <div className="actions">
          <HeadChoice
            label="Keys that hold"
            value={scope}
            options={KEYMAP_SCOPES}
            onChange={onScope}
          />
          <HeadChoice
            label="Show"
            land="filter"
            value={filter}
            options={KEYMAP_FILTERS}
            onChange={setFilter}
          />
          <ResetAll state={state} onLand={land} />
        </div>
      </div>
      <div className="panel__body">
        <KeymapFind
          query={query}
          onQuery={setQuery}
          recorded={recorded}
          onRecorded={setRecorded}
        />
        <CharacterKeys state={state} />
        <CommandCount
          shown={shown}
          signal={[query, recorded, filter, scope].join("\u0000")}
        />
        {groups.map((group) => (
          <section
            key={group.id}
            className="kb-group"
            aria-labelledby={`kb-group-${group.id}`}
          >
            <h3 className="kb-group__label" id={`kb-group-${group.id}`}>
              {group.label}
            </h3>
            <ul className="kb-rows">
              {group.rows.map((row) => (
                <Row
                  key={row.command.id}
                  row={row}
                  state={state}
                  onLand={land}
                />
              ))}
            </ul>
          </section>
        ))}
        {whole && (filter === "all" || filter === "changed") ? (
          <UnavailableKeys
            bindings={unavailableBindings(state.config, state.commands)}
            state={state}
          />
        ) : null}
        {whole && filter === "all" ? <FixedKeys /> : null}
      </div>
    </section>
  );
}
