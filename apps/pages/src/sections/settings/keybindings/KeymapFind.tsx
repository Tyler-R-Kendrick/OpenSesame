import {
  MAX_SEQUENCE,
  formatSequence,
  keycapLabel,
  parseSequence,
  tokenFromPress,
} from "@opensesame/app-core/lib/keymap/notation.js";
import { useRef } from "react";
import { IconKeyboard } from "../../../components/Icons.js";
import { keymapSeams } from "../../../lib/keymap.js";

/**
 * Find a command by words, or — with the keyboard key pressed — by pressing
 * the keys themselves (VS Code's "Record Keys", JetBrains' "Find by
 * shortcut"): `g` lists everything `g` starts, `g v` the one it runs. A pause
 * longer than the keymap's timeout starts a new sequence. Escape stops
 * recording; Tab leaves.
 */
export function KeymapFind({
  query,
  onQuery,
  recorded,
  onRecorded,
}: {
  query: string;
  onQuery: (query: string) => void;
  recorded: string | null;
  onRecorded: (recorded: string | null) => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const last = useRef(0);
  const recording = recorded !== null;
  const shown = recording
    ? (parseSequence(recorded) ?? []).map(keycapLabel).join(" ")
    : query;
  const label = recording ? "Press the keys to find" : "Find a command";
  return (
    <div className="field-inline kb-find">
      <input
        ref={field}
        type={recording ? "text" : "search"}
        className={recording ? "kb-find__keys" : undefined}
        data-key-capture={recording ? "" : undefined}
        aria-label={label}
        placeholder={recording ? "press keys" : "find a command"}
        autoComplete="off"
        spellCheck={false}
        value={shown}
        readOnly={recording}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (!recording) return;
          const key = event.nativeEvent;
          if (key.key === "Tab") return;
          event.preventDefault();
          if (key.key === "Escape") {
            onRecorded(null);
            return;
          }
          const token = tokenFromPress(key);
          if (token === null) return;
          const now = Date.now();
          const fresh = now - last.current > keymapSeams.goTimeoutMs;
          last.current = now;
          const held =
            fresh || recorded === "" ? [] : (parseSequence(recorded) ?? []);
          onRecorded(formatSequence([...held, token].slice(-MAX_SEQUENCE)));
        }}
      />
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-pressed={recording}
        aria-label="Find by pressing keys"
        title="Find by pressing keys"
        onClick={() => {
          last.current = 0;
          onRecorded(recording ? null : "");
          field.current?.focus();
        }}
      >
        <IconKeyboard size={14} />
      </button>
    </div>
  );
}
