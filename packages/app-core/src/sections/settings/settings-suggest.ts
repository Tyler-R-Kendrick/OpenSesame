/**
 * Where a caret is in a `config.yaml`, for completion (ADR 0134, ADR 0156):
 * the line it is on, whether that line sits inside the `keybindings:` mapping
 * or a `contexts.<listing>` mapping, and what has been typed of the key or
 * the value. Pure text in, text out; no DOM.
 */
import {
  MACRO_PREFIX,
  NOP,
  keymapCommands,
} from "../../lib/keymap/commands.js";
import { authorityLocked } from "../../lib/keymap/config.js";
import { isKeymapContext } from "../../lib/keymap/context.js";
import { defaultBindings } from "../../lib/keymap/effective.js";
import {
  GESTURE_IDS,
  gestureBindingProblem,
} from "../../lib/keymap/gestures.js";
import { canonicalSequence } from "../../lib/keymap/notation.js";
import { yamlKey, yamlWord } from "./settings-keymap-yaml.js";

export type LineAt = Readonly<{ text: string; start: number; end: number }>;

/** The line the caret is on, and where it starts and ends in `source`. */
export function lineAt(source: string, caret: number): LineAt {
  const start = caret <= 0 ? 0 : source.lastIndexOf("\n", caret - 1) + 1;
  const stop = source.indexOf("\n", caret);
  const end = stop === -1 ? source.length : stop;
  return { text: source.slice(start, end), start, end };
}

export function indentOf(text: string): number {
  return text.length - text.trimStart().length;
}

/** A key or value with the quotes around it (or half of them) taken off. */
export function unquote(written: string): string {
  return written.replace(/^["']/, "").replace(/["']$/, "");
}

/**
 * Where the `:` between a line's key and its value is, or -1. A quoted key
 * may hold a colon (`":"`), so its closing quote is found first.
 */
export function separatorAt(text: string): number {
  const at = indentOf(text);
  const quote = text[at];
  if (quote !== '"' && quote !== "'") return text.indexOf(":", at);
  let close = at + 1;
  while (close < text.length && text[close] !== quote)
    close += text[close] === "\\" && quote === '"' ? 2 : 1;
  if (close >= text.length) return -1;
  const colon = text.indexOf(":", close + 1);
  return colon !== -1 && text.slice(close + 1, colon).trim() === ""
    ? colon
    : -1;
}

/** The key a `key:` line names, or null. */
function keyName(text: string): string | null {
  const colon = separatorAt(text);
  if (colon === -1) return null;
  return unquote(text.slice(indentOf(text), colon).trim());
}

function isBlank(text: string): boolean {
  return text.trim() === "" || text.trimStart().startsWith("#");
}

/** The nearest earlier line indented less than `indent`, or -1. */
function parentOf(
  lines: readonly string[],
  index: number,
  indent: number,
): number {
  for (let at = index - 1; at >= 0; at -= 1) {
    const text = lines[at] ?? "";
    if (!isBlank(text) && indentOf(text) < indent) return at;
  }
  return -1;
}

/**
 * Whether the caret's line is a key of the `keybindings:` mapping or of a
 * `contexts.<listing>` mapping — the only places a key or an action id is
 * written. Read by scanning back to the nearest less-indented key, so a
 * `steps: [3 listing.next]` line under `macros:` is not one of them.
 */
export function inBindings(source: string, caret: number): boolean {
  const lines = source.split("\n");
  const index = source.slice(0, caret).split("\n").length - 1;
  const indent = indentOf(lines[index] ?? "");
  if (indent === 0) return false;
  const parent = parentOf(lines, index, indent);
  const name = parent === -1 ? null : keyName(lines[parent] ?? "");
  if (name === null) return false;
  const level = indentOf(lines[parent] ?? "");
  if (name === "keybindings") return level === 0;
  if (!isKeymapContext(name)) return false;
  const grand = parentOf(lines, parent, level);
  return (
    grand !== -1 &&
    indentOf(lines[grand] ?? "") === 0 &&
    keyName(lines[grand] ?? "") === "contexts"
  );
}

/**
 * Whether the caret's line is a key of the `gestures:` mapping (ADR 0170),
 * where a gesture's name is the key and an action id the value.
 */
export function inGestures(source: string, caret: number): boolean {
  const lines = source.split("\n");
  const index = source.slice(0, caret).split("\n").length - 1;
  const indent = indentOf(lines[index] ?? "");
  if (indent === 0) return false;
  const parent = parentOf(lines, index, indent);
  return (
    parent !== -1 &&
    indentOf(lines[parent] ?? "") === 0 &&
    keyName(lines[parent] ?? "") === "gestures"
  );
}

export type Typing = Readonly<{
  /** Before the colon (a key), or after it (an action id or a value). */
  position: "key" | "value";
  /** What has been typed of it, up to the caret, quotes off. */
  typed: string;
}>;

/** What has been typed at the caret, of the key or of its value. */
export function typingAt(source: string, caret: number): Typing {
  const { text, start } = lineAt(source, caret);
  const column = caret - start;
  const colon = separatorAt(text);
  if (colon !== -1 && column > colon) {
    return {
      position: "value",
      typed: unquote(text.slice(colon + 1, column).trimStart()),
    };
  }
  const stop = colon === -1 ? column : Math.min(column, colon);
  return {
    position: "key",
    typed: unquote(text.slice(indentOf(text), stop).trimStart()),
  };
}

/** The macros a file names under `macros:`, as the ids a key binds. */
function macroIds(source: string): string[] {
  const lines = source.split("\n");
  const at = lines.findIndex((text) => /^macros\s*:/.test(text));
  if (at === -1) return [];
  const ids: string[] = [];
  let level = -1;
  for (const text of lines.slice(at + 1)) {
    if (isBlank(text)) continue;
    const indent = indentOf(text);
    if (indent === 0) break;
    if (level === -1) level = indent;
    const name = indent === level ? keyName(text) : null;
    if (name) ids.push(`${MACRO_PREFIX}${name}`);
  }
  return ids;
}

/**
 * Keys and action ids for a line inside a bindings mapping, narrowed to what
 * the person has typed. Everything that matches is offered: the caller may
 * show fewer, but never cuts the list before it has been narrowed. A key is
 * written the way the file would write it (quoted when YAML would misread it).
 */
export function bindingSuggestions(source: string, caret: number): string[] {
  const { position, typed } = typingAt(source, caret);
  if (position === "key") {
    return [...defaultBindings(keymapCommands()).keys()]
      .filter((sequence) => sequence.startsWith(typed))
      .map(yamlKey);
  }
  const commands = keymapCommands();
  const defaults = defaultBindings(commands);
  const written = keyName(lineAt(source, caret).text) ?? "";
  // The file judges a key by its canonical spelling, so the list must too.
  const key = canonicalSequence(written) ?? written;
  const ids = [
    ...commands.map((command) => command.id),
    ...macroIds(source),
    NOP,
  ];
  // A finished action is not offered back. A finished key still is, so Tab
  // can write the colon after it. Nor is one the file would refuse for this
  // key: a command that asks first keeps only its own locked keys.
  return [...new Set(ids)]
    .filter(
      (id) =>
        id !== typed &&
        id.startsWith(typed) &&
        !authorityLocked(key, id, commands, defaults),
    )
    .map(yamlWord);
}

/**
 * Gesture names and action ids for a line inside `gestures:`, narrowed to
 * what has been typed. A gesture is offered only the actions it may bind:
 * nothing that asks first, and no register key.
 */
export function gestureSuggestions(source: string, caret: number): string[] {
  const { position, typed } = typingAt(source, caret);
  if (position === "key")
    return GESTURE_IDS.filter((id) => id.startsWith(typed));
  const commands = keymapCommands();
  const macros = Object.fromEntries(
    macroIds(source).map((id) => [
      id.slice(MACRO_PREFIX.length),
      { steps: [] },
    ]),
  );
  const ids = [
    ...commands.map((command) => command.id),
    ...macroIds(source),
    NOP,
  ];
  return [...new Set(ids)]
    .filter(
      (id) =>
        id !== typed &&
        id.startsWith(typed) &&
        gestureBindingProblem(id, commands, macros) === null,
    )
    .map(yamlWord);
}
