import type { KeymapCommand } from "@opensesame/app-core/lib/keymap/commands.js";
import { targetLabel } from "@opensesame/app-core/lib/keymap/effective.js";
import {
  parseSequence,
  spokenSequence,
} from "@opensesame/app-core/lib/keymap/notation.js";
import { useEffect, useRef } from "react";
import { IconCheck, IconSwap, IconX } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { Keycaps } from "./Keycaps.js";
import type { Refusal } from "./useBindFlow.js";

/**
 * The key is taken. Nothing is overwritten quietly: the prompt names what
 * holds it, and the person chooses — swap (the holder takes the key being
 * replaced, as a game's binding screen offers), take it (the holder loses
 * it), or keep things as they were. A command that asks before it acts never
 * gains a key, so it is never offered a swap.
 */
export function ConflictPrompt({
  sequence,
  holder,
  commands,
  canSwap,
  problem,
  onSwap,
  onReplace,
  onCancel,
}: {
  sequence: string;
  holder: string;
  commands: readonly KeymapCommand[];
  canSwap: boolean;
  /** Why the swap or take was refused (storage said no), drawn as a mark. */
  problem?: Refusal | null;
  onSwap: () => void;
  onReplace: () => void;
  onCancel: () => void;
}) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);
  const said = spokenSequence(parseSequence(sequence) ?? [sequence]);
  const name = targetLabel(holder, commands);
  return (
    <fieldset
      className="kb-conflict"
      aria-label={`${said} is taken by ${name}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onCancel();
      }}
      data-key-capture=""
    >
      <StatusMark tone="warn" label={`${said} is taken by ${name}`} />
      <span className="kb-conflict__what">
        <Keycaps sequence={sequence} />
        <span className="kb-conflict__holder">{name}</span>
      </span>
      {problem ? <StatusMark tone="err" label={problem.message} /> : null}
      <span className="actions">
        {canSwap ? (
          <button
            ref={first}
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label={`Swap: ${name} takes the key you replaced`}
            title={`Swap: ${name} takes the key you replaced`}
            onClick={onSwap}
          >
            <IconSwap size={14} />
          </button>
        ) : null}
        <button
          ref={canSwap ? undefined : first}
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label={`Take ${said}: ${name} loses it`}
          title={`Take ${said}: ${name} loses it`}
          onClick={onReplace}
        >
          <IconCheck size={14} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="Keep things as they were"
          title="Keep things as they were (Esc)"
          onClick={onCancel}
        >
          <IconX size={14} />
        </button>
      </span>
    </fieldset>
  );
}
