import { keymapCommands } from "@opensesame/app-core/lib/keymap/commands.js";
import { keycapLabel } from "@opensesame/app-core/lib/keymap/notation.js";
import { registerMacroName } from "@opensesame/app-core/lib/keymap/registers.js";
import { loadKeymap } from "@opensesame/app-core/lib/keymap/store.js";
import { useSyncExternalStore } from "react";
import {
  type Continuation,
  type PendingKeys as Pending,
  continuationsOf,
  hasPending,
  pendingSnapshot,
  subscribePending,
} from "../lib/keymap-pending.js";
import { currentBindings } from "../lib/keymap.js";

/** Which-key stops here: one row never holds the whole `g` list anyway. */
const MAX_SHOWN = 12;

/** The registers `@` can replay right now: `a`, `q`… */
function savedRegisters(): Continuation[] {
  const macros = loadKeymap().macros;
  return [..."abcdefghijklmnopqrstuvwxyz"]
    .filter((letter) => Object.hasOwn(macros, registerMacroName(letter)))
    .map((key) => ({ key, label: null }));
}

function nextKeys(pending: Pending): Continuation[] {
  if (pending.awaiting === "replay") return savedRegisters();
  if (pending.awaiting === "record") return [];
  // The keys of the listing the prefix was typed in, as the handler reads them.
  return continuationsOf(
    currentBindings(pending.context),
    pending.keys,
    keymapCommands(),
  );
}

function WhichKey({ pending }: { pending: Pending }) {
  const next = nextKeys(pending).slice(0, MAX_SHOWN);
  if (next.length === 0) return null;
  return (
    <ul className="pending-keys__which" aria-label="Next keys">
      {next.map(({ key, label }) => (
        <li key={key}>
          <kbd>{keycapLabel(key)}</kbd>
          {label === null ? null : ` ${label}`}
        </li>
      ))}
    </ul>
  );
}

/**
 * vim's `showcmd` and which-key, in the statusline (ADR 0155): the count and
 * keys typed so far, what each next key runs, and `recording @a` while a
 * register records. A screen reader hears a recording start and stop, never
 * each key.
 */
export function PendingKeys() {
  const pending = useSyncExternalStore(
    subscribePending,
    pendingSnapshot,
    pendingSnapshot,
  );
  const typed = pending.count > 0 || pending.keys.length > 0;
  return (
    <div className="statusline__keys">
      <span className="visually-hidden" aria-live="polite">
        {pending.announcement}
      </span>
      {hasPending(pending) ? (
        <div className="pending-keys">
          {pending.recording === null ? null : (
            <span className="pending-keys__rec">
              recording @{pending.recording}
            </span>
          )}
          {typed ? (
            <span className="pending-keys__typed">
              {pending.count > 0 ? <kbd>{pending.count}</kbd> : null}
              {pending.keys.map((key, index) => (
                <kbd key={`${index}-${key}`}>{keycapLabel(key)}</kbd>
              ))}
            </span>
          ) : null}
          <WhichKey pending={pending} />
        </div>
      ) : null}
    </div>
  );
}
