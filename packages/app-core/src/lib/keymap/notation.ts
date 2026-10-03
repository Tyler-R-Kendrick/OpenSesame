/**
 * Key notation for the keymap (ADR 0156): one token per key press, a
 * sequence of tokens per binding.
 *
 * A token is the key's own name, with `Control+` in front when Control was
 * held: `j`, `G`, `?`, `Control+d`, `ArrowDown`, `Space`. Shift is folded into
 * a printed character (`G`, `$`, `?`) because that character already says it
 * was pressed; it is spelled only on a named key (`Shift+Tab`). A sequence is
 * its tokens joined by one space — `g v`, `Space f`, `Control+k Control+s` —
 * so the file and the keycaps say the same thing.
 */

export type KeyPress = Readonly<{
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  /** AltGr held (`getModifierState("AltGraph")`); Windows also reports it as Control+Alt. */
  altGraph?: boolean;
  /** A `KeyboardEvent`'s own: asked for `AltGraph` when `altGraph` is not given. */
  getModifierState?: (key: string) => boolean;
}>;

/** A sequence is at most four presses; a longer one is a macro. */
export const MAX_SEQUENCE = 4;

const NAMED = new Set([
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "Backspace",
  "Delete",
  "End",
  "Enter",
  "Escape",
  "Home",
  "Insert",
  "PageDown",
  "PageUp",
  "Space",
  "Tab",
  "ContextMenu",
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
]);

const ALIASES = new Map([
  [" ", "Space"],
  ["Spacebar", "Space"],
  ["Esc", "Escape"],
  ["Down", "ArrowDown"],
  ["Up", "ArrowUp"],
  ["Left", "ArrowLeft"],
  ["Right", "ArrowRight"],
  ["Ctrl", "Control"],
]);

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS"]);

/** One printable character that is not a letter or a digit: `@`, `€`, `\`. */
function isSymbol(key: string): boolean {
  return key.length === 1 && !/[\sA-Za-z0-9\p{C}]/u.test(key);
}

/**
 * A press that made a symbol with Alt or Option held: `@` is Option+L on a
 * German Mac. The character is what was typed, so the token is the character
 * alone. Alt with a letter, a digit or a named key is a browser mnemonic and
 * stays refused.
 */
function altSymbol(press: KeyPress): string | null {
  return isSymbol(press.key) ? press.key : null;
}

/**
 * The token a key press is, or null for one the keymap never sees: a bare
 * modifier, an IME composition, an unidentified soft-keyboard key, or a press
 * with Alt or Meta held (the platform's and the browser's) — unless Alt,
 * Option or AltGr made a symbol, which is that symbol. AltGr is Control+Alt
 * on Windows, so `@` on a Spanish keyboard arrives as both; it is `@`, not
 * `Control+@`.
 */
export function tokenFromPress(press: KeyPress): string | null {
  if (press.metaKey) return null;
  if (press.altKey) return altSymbol(press);
  const base = keyBase(press.key);
  if (base === null) return null;
  const shift = press.shiftKey && base.length > 1 ? "Shift+" : "";
  return `${controlPrefix(press, base)}${shift}${base}`;
}

/** The key's own name, or null for a modifier, a dead key or a name we lack. */
function keyBase(written: string): string | null {
  const key = ALIASES.get(written) ?? written;
  if (MODIFIER_KEYS.has(key) || key === "Unidentified" || key === "Dead")
    return null;
  return key.length === 1 || NAMED.has(key) ? key : null;
}

/** `Control+` when Control was held — AltGr's Control is part of the symbol. */
function controlPrefix(press: KeyPress, base: string): string {
  if (!press.ctrlKey) return "";
  const altGraph = press.altGraph ?? press.getModifierState?.("AltGraph");
  return altGraph && isSymbol(base) ? "" : "Control+";
}

/**
 * Canonical spelling of one written token, or null when it names no key.
 * `Shift+?` and `Shift+G` fold to `?` and `G`; `ctrl+D` reads as `Control+D`.
 */
export function normalizeToken(written: string): string | null {
  if (written === "") return null;
  if (written.length === 1) return written === " " ? "Space" : written;
  const parts = written.split("+");
  // A trailing `+` is the plus key itself: `Control++`.
  if (written.endsWith("++")) parts.splice(-2, 2, "+");
  const key = parts.pop();
  if (key === undefined || key === "") return null;
  const modifiers = readModifiers(parts);
  if (modifiers === null) return null;
  const { control, shift } = modifiers;
  return tokenFromPress({
    key: keyName(key, shift),
    ctrlKey: control,
    shiftKey: shift,
  });
}

/** `Control` and `Shift` in any spelling; anything else names no key. */
function readModifiers(
  parts: readonly string[],
): { control: boolean; shift: boolean } | null {
  let control = false;
  let shift = false;
  for (const part of parts) {
    const spelled = capitalize(part);
    const modifier = ALIASES.get(part) ?? ALIASES.get(spelled) ?? spelled;
    if (modifier === "Control") control = true;
    else if (modifier === "Shift") shift = true;
    else return null;
  }
  return { control, shift };
}

/** `g` with Shift is `G`; `pagedown` is `PageDown`. */
function keyName(key: string, shift: boolean): string {
  const alias = ALIASES.get(key);
  if (alias !== undefined) return alias;
  if (key.length > 1) return capitalize(key);
  return shift && /^[a-z]$/.test(key) ? key.toUpperCase() : key;
}

function capitalize(word: string): string {
  if (/^f\d{1,2}$/i.test(word)) return word.toUpperCase();
  if (/^arrow/i.test(word)) return `Arrow${capitalize(word.slice(5))}`;
  if (/^page(up|down)$/i.test(word)) return `Page${capitalize(word.slice(4))}`;
  if (/^contextmenu$/i.test(word)) return "ContextMenu";
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** A written sequence as tokens, or null when any of it names no key. */
export function parseSequence(written: string): string[] | null {
  const words = written.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > MAX_SEQUENCE) return null;
  const tokens: string[] = [];
  for (const word of words) {
    const token = normalizeToken(word);
    if (token === null) return null;
    tokens.push(token);
  }
  return tokens;
}

export function formatSequence(tokens: readonly string[]): string {
  return tokens.join(" ");
}

/** The canonical spelling of a written sequence, or null. */
export function canonicalSequence(written: string): string | null {
  const tokens = parseSequence(written);
  return tokens === null ? null : formatSequence(tokens);
}

const GLYPH = new Map([
  ["ArrowDown", "↓"],
  ["ArrowUp", "↑"],
  ["ArrowLeft", "←"],
  ["ArrowRight", "→"],
  ["PageDown", "PgDn"],
  ["PageUp", "PgUp"],
  ["Backspace", "Bksp"],
  ["Escape", "Esc"],
  ["Delete", "Del"],
  ["Insert", "Ins"],
  ["ContextMenu", "Menu"],
]);

/** How one token is drawn on a keycap: `Ctrl-d`, `↓`, `PgDn`, `G`. */
export function keycapLabel(token: string): string {
  let rest = token;
  let prefix = "";
  if (rest.startsWith("Control+") && rest.length > "Control+".length) {
    prefix += "Ctrl-";
    rest = rest.slice("Control+".length);
  }
  if (rest.startsWith("Shift+") && rest.length > "Shift+".length) {
    prefix += "Shift-";
    rest = rest.slice("Shift+".length);
  }
  return `${prefix}${GLYPH.get(rest) ?? rest}`;
}

/** The words a screen reader hears for a sequence: `g then v`. */
export function spokenSequence(tokens: readonly string[]): string {
  return tokens
    .map((token) => keycapLabel(token).replace("Ctrl-", "Control "))
    .join(" then ");
}

/**
 * A press of one printed character with no Control: WCAG 2.1.4's "character
 * key shortcut", which a person must be able to turn off.
 */
export function isCharacterKey(token: string): boolean {
  return token.length === 1 || token === "Space";
}
