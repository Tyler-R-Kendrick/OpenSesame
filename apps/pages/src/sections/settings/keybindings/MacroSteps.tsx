import {
  GROUP_LABEL,
  GROUP_ORDER,
  type KeymapCommand,
} from "@opensesame/app-core/lib/keymap/commands.js";
import {
  type KeymapEvent,
  MACRO_LIMITS,
  type MacroStep,
  stepProblem,
} from "@opensesame/app-core/lib/keymap/config.js";
import {
  keycapLabel,
  tokenFromPress,
} from "@opensesame/app-core/lib/keymap/notation.js";
import { type RefObject, useEffect, useRef, useState } from "react";
import {
  IconChevronDown,
  IconChevronUp,
  IconPlus,
  IconRecord,
  IconTrash,
} from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import type { KeymapState } from "./useKeymap.js";
import { useMoveLanding } from "./useMoveLanding.js";
import { useStepRecorder } from "./useStepRecorder.js";

/** Commands a step may name: never one that asks first, never a no-op. */
function stepCommands(
  commands: readonly KeymapCommand[],
  on: KeymapEvent | undefined,
) {
  return GROUP_ORDER.map((group) => ({
    group,
    commands: commands.filter(
      (command) =>
        command.group === group &&
        stepProblem({ command: command.id, count: 1 }, on, commands) === null,
    ),
  })).filter((entry) => entry.commands.length > 0);
}

function move<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

/**
 * The recorder: press keys as you would use them, and each press that runs a
 * command becomes a step — `3j` a `3 listing.next`, `g s` a jump. What a
 * macro may not run is left out and named. Recording stops on the record key,
 * Enter or Escape; Tab leaves and keeps what was pressed.
 */
function Recorder({
  tokens,
  onToken,
  onStop,
}: {
  tokens: readonly string[];
  onToken: (token: string) => void;
  /** `refocus` is false when Tab is already carrying focus onward. */
  onStop: (refocus: boolean) => void;
}) {
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: the person pressed record; the keys they press next are the macro
      autoFocus
      className="kb-steps__recorder"
      data-key-capture=""
      aria-label="Recording: press the keys the macro should press"
      placeholder="press keys · Enter stops"
      readOnly
      value={tokens.map(keycapLabel).join(" ")}
      onKeyDown={(event) => {
        const key = event.nativeEvent;
        // Tab and Shift-Tab leave, and keep what was pressed: finish the
        // recording, but leave the press alone so focus moves natively.
        if (key.key === "Tab") {
          onStop(false);
          return;
        }
        event.preventDefault();
        if (key.key === "Enter" || key.key === "Escape") {
          onStop(true);
          return;
        }
        const token = tokenFromPress(key);
        if (token !== null) onToken(token);
      }}
    />
  );
}

type Choices = ReturnType<typeof stepCommands>;

function clampCount(value: string): number {
  return Math.max(1, Math.min(MACRO_LIMITS.count, Number(value) || 1));
}

/** One step: how many times, which command, and where it sits. */
function StepRow({
  step,
  index,
  last,
  problem,
  choices,
  onStep,
  onMove,
  onRemove,
}: {
  step: MacroStep;
  index: number;
  last: boolean;
  problem: string | null;
  choices: Choices;
  onStep: (step: MacroStep) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  // A step may be kept though it is not offered (a section whose capability
  // is absent today): the select still has to show what will be saved.
  const offered = choices.some((entry) =>
    entry.commands.some((command) => command.id === step.command),
  );
  return (
    <li className="kb-step" data-step={index}>
      <input
        type="number"
        className="kb-step__count"
        min={1}
        max={MACRO_LIMITS.count}
        aria-label={`Times for step ${n}`}
        value={step.count}
        onChange={(event) =>
          onStep({ ...step, count: clampCount(event.target.value) })
        }
      />
      <span className="kb-step__times" aria-hidden="true">
        ×
      </span>
      <select
        className="kb-step__command"
        aria-label={`Command for step ${n}`}
        value={step.command}
        onChange={(event) => onStep({ ...step, command: event.target.value })}
      >
        {offered ? null : <option value={step.command}>{step.command}</option>}
        {choices.map((entry) => (
          <optgroup key={entry.group} label={GROUP_LABEL[entry.group]}>
            {entry.commands.map((command) => (
              <option key={command.id} value={command.id}>
                {command.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {problem ? <StatusMark tone="err" label={problem} /> : null}
      <span className="actions">
        {/* The first step cannot go up, nor the last down: no key (ADR 0158). */}
        {index === 0 ? null : (
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label={`Move step ${n} up`}
            title="Move up"
            data-move="up"
            onClick={() => onMove(index - 1)}
          >
            <IconChevronUp size={14} />
          </button>
        )}
        {last ? null : (
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label={`Move step ${n} down`}
            title="Move down"
            data-move="down"
            onClick={() => onMove(index + 1)}
          >
            <IconChevronDown size={14} />
          </button>
        )}
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label={`Remove step ${n}`}
          title="Remove step"
          onClick={onRemove}
        >
          <IconTrash size={14} />
        </button>
      </span>
    </li>
  );
}

/** Add a step, record steps, and what a recording left out. */
function StepsFoot({
  steps,
  choices,
  recorder,
  addRef,
  onChange,
}: {
  steps: readonly MacroStep[];
  choices: Choices;
  recorder: ReturnType<typeof useStepRecorder>;
  addRef: RefObject<HTMLButtonElement | null>;
  onChange: (steps: MacroStep[]) => void;
}) {
  const full = steps.length >= MACRO_LIMITS.steps;
  const { recording } = recorder;
  return (
    <div className="kb-steps__foot">
      {/* At the step limit, or while keys are being recorded, adding a step
          is not on offer: the key is not drawn (ADR 0158). */}
      {full || recording ? null : (
        <button
          ref={addRef}
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="Add a step"
          title="Add a step"
          onClick={() =>
            onChange([
              ...steps,
              {
                command: choices[0]?.commands[0]?.id ?? "listing.next",
                count: 1,
              },
            ])
          }
        >
          <IconPlus size={14} />
        </button>
      )}
      {full && !recording ? null : (
        <button
          type="button"
          className={`icon-btn icon-btn--sm${recording ? " is-armed" : ""}`}
          aria-pressed={recording}
          aria-label={
            recording ? "Stop recording" : "Record steps by pressing keys"
          }
          title={
            recording
              ? "Stop recording (Enter)"
              : "Record steps by pressing keys"
          }
          onClick={recorder.toggle}
        >
          <IconRecord size={14} />
        </button>
      )}
      {recording ? (
        <Recorder
          tokens={recorder.tokens}
          onToken={recorder.add}
          onStop={recorder.finish}
        />
      ) : null}
      {!recording && recorder.skipped.length > 0 ? (
        <StatusMark
          tone="warn"
          label={`Left out: ${recorder.skipped.join(", ")} — not something this macro may run`}
        />
      ) : null}
    </div>
  );
}

export function MacroSteps({
  steps,
  on,
  state,
  onChange,
}: {
  steps: readonly MacroStep[];
  on: KeymapEvent | undefined;
  state: KeymapState;
  onChange: (steps: MacroStep[]) => void;
}) {
  const addRef = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const land = useMoveLanding(list);
  // The Add key comes and goes with the limit and with recording, so focus is
  // sent to it after the render that draws it — or, with the steps full, to
  // the last step, rather than left on a key that is gone.
  const [refocus, setRefocus] = useState(0);
  const wanted = useRef(false);
  const focusAdd = () => {
    wanted.current = true;
    setRefocus((n) => n + 1);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus and the step count are what retrigger it
  useEffect(() => {
    const active = document.activeElement;
    const idle = active === null || active === document.body;
    if (wanted.current && addRef.current) {
      wanted.current = false;
      if (idle || list.current?.contains(active)) addRef.current.focus();
      return;
    }
    if (idle && !addRef.current && steps.length >= MACRO_LIMITS.steps) {
      wanted.current = false;
      list.current?.querySelector<HTMLElement>("li:last-child select")?.focus();
    }
  }, [refocus, steps.length]);
  const recorder = useStepRecorder(steps, on, state, onChange, focusAdd);
  const choices = stepCommands(state.commands, on);

  return (
    <div className="kb-steps">
      <ol className="kb-steps__list" ref={list}>
        {steps.map((step, index) => (
          <StepRow
            // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional; a step may repeat
            key={index}
            step={step}
            index={index}
            last={index === steps.length - 1}
            problem={stepProblem(step, on, state.commands)}
            choices={choices}
            onStep={(next) =>
              onChange(steps.map((item, at) => (at === index ? next : item)))
            }
            onMove={(to) => {
              onChange(move(steps, index, to));
              land({ index: to, dir: to > index ? "down" : "up" });
            }}
            onRemove={() => {
              onChange(steps.filter((_, at) => at !== index));
              focusAdd();
            }}
          />
        ))}
      </ol>
      <StepsFoot
        steps={steps}
        choices={choices}
        recorder={recorder}
        addRef={addRef}
        onChange={onChange}
      />
    </div>
  );
}
