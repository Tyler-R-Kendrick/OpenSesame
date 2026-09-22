/** In-app `?` sheet rows — must stay in lockstep with DESIGN.md and the handler. */

/** Every row but the section jumps, which depend on what is registered. */
export const KEYMAP_HELP_CORE = [
  ["Ctrl-l / :", "Command bar"],
  ["m", "Push to speak"],
  ["j / k or arrows", "Move"],
  ["3j  10k", "Repeat a motion"],
  ["Ctrl-d / u", "Half-page"],
  ["Ctrl-f / b or PgUp/Dn", "Page"],
  ["H / M / L", "High, mid, low"],
  ["gg / G  0 / $", "First or last"],
  ["l / h  Enter  Backspace", "Dive or climb"],
  ["Tab / Shift-Tab", "Next or previous control"],
  ["F6", "Other listing"],
  ["/  Esc", "Search or focus the tree"],
  ["y / u", "Copy secret or username"],
  ["e / x", "Edit or trash"],
  ["n / .", "New or favorite"],
  ["s", "Share once"],
] as const;

export type KeymapHelpRow = readonly [keys: string, action: string];

/** The `g` row spells out exactly the jumps that exist: `g v/s` on a core-only plan. */
export function keymapJumpHelpRow(jumpKeys: readonly string[]): KeymapHelpRow {
  return [`g ${jumpKeys.join("/")}`, "Go to a section"];
}

/** The whole sheet for a given set of registered jump keys. */
export function keymapHelpRows(
  jumpKeys: readonly string[],
): readonly KeymapHelpRow[] {
  return [...KEYMAP_HELP_CORE, keymapJumpHelpRow(jumpKeys)];
}

let helpTarget: (() => void) | null = null;

export function registerKeymapHelp(show: () => void): () => void {
  helpTarget = show;
  return () => {
    if (helpTarget === show) helpTarget = null;
  };
}

export function showKeymapHelp(): void {
  helpTarget?.();
}
