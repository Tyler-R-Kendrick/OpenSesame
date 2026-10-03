import { commandById } from "@opensesame/app-core/lib/keymap/commands.js";
import { CONTEXT_LABEL } from "@opensesame/app-core/lib/keymap/context.js";
import type { KeyCell } from "@opensesame/app-core/sections/settings/keymap-panel-model.js";
import { IconPlus, IconTrash, IconX } from "../../../components/Icons.js";
import { ConflictPrompt } from "./ConflictPrompt.js";
import { KeyButton, spoken } from "./KeyButton.js";
import { KeyCapture, keepFocus } from "./KeyCapture.js";
import { ADD_KEY, useBindFlow } from "./useBindFlow.js";
import type { KeymapState } from "./useKeymap.js";

type Flow = ReturnType<typeof useBindFlow>;

/** The capture in place of a keycap (`previous`) or of `+`. */
function CaptureSlot({
  flow,
  label,
  previous,
}: {
  flow: Flow;
  label: string;
  previous?: string;
}) {
  const back = previous ?? ADD_KEY;
  return (
    <KeyCapture
      label={
        previous
          ? `New key in place of ${spoken(previous)} for ${label}`
          : `New key for ${label}`
      }
      problem={flow.problem}
      onCommit={flow.propose}
      onCancel={() => flow.close(back)}
    >
      {previous ? (
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label={`Remove ${spoken(previous)} from ${label}`}
          title={`Remove ${spoken(previous)}`}
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
          onClick={() => flow.remove(previous)}
        >
          <IconTrash size={14} />
        </button>
      ) : null}
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Cancel"
        title="Cancel (Esc)"
        onPointerDown={keepFocus}
        onMouseDown={keepFocus}
        onClick={() => flow.close(back)}
      >
        <IconX size={14} />
      </button>
    </KeyCapture>
  );
}

/**
 * A command's keys, each a keycap that re-records itself, then `+` for one
 * more — WoW's binding slots, VS Code's chords, Obsidian's chips. A default a
 * person struck stays drawn, struck through, and pressing it brings it back.
 * A key that shares a prefix with another is marked: the shorter one waits
 * for the timeout. A locked command's keys are drawn, never offered.
 */
export function BoundKeys({
  target,
  label,
  keys,
  locked = false,
  state,
}: {
  target: string;
  label: string;
  keys: readonly KeyCell[];
  locked?: boolean;
  state: KeymapState;
}) {
  const flow = useBindFlow(target, state);
  const { editing, pending } = flow;
  // Recording lands where the table is looking, and every label says so.
  const here = state.scope ? `${label} ${CONTEXT_LABEL[state.scope]}` : label;
  const holderLocked =
    pending !== null &&
    commandById(pending.holder, state.commands)?.kind === "authority";
  return (
    <div className="kb-keys" ref={flow.cell}>
      {keys.map((cell) =>
        editing?.previous === cell.sequence ? (
          <CaptureSlot
            key={cell.sequence}
            flow={flow}
            label={here}
            previous={cell.sequence}
          />
        ) : (
          <KeyButton
            key={cell.sequence}
            cell={cell}
            label={label}
            locked={locked}
            scope={state.scope}
            onChange={() => flow.start(cell.sequence)}
            onRestore={() =>
              flow.restore(cell.sequence, cell.scope !== undefined)
            }
          />
        ),
      )}
      {editing && editing.previous === undefined ? (
        <CaptureSlot flow={flow} label={here} />
      ) : null}
      {!locked && editing === null && pending === null ? (
        <button
          type="button"
          className="icon-btn icon-btn--sm kb-keys__add"
          data-add-key=""
          aria-label={`Add a key for ${here}`}
          title={`Add a key for ${here}`}
          onClick={() => flow.start()}
        >
          <IconPlus size={14} />
        </button>
      ) : null}
      {pending ? (
        <ConflictPrompt
          sequence={pending.sequence}
          holder={pending.holder}
          commands={state.commands}
          canSwap={pending.previous !== undefined && !holderLocked}
          problem={flow.problem}
          onSwap={() => flow.commit(pending.sequence, pending.previous, "swap")}
          onReplace={() => flow.commit(pending.sequence, pending.previous)}
          onCancel={() => flow.close(pending.previous ?? ADD_KEY)}
        />
      ) : null}
    </div>
  );
}
