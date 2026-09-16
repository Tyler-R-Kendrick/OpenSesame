/** In-app `?` sheet rows — must stay in lockstep with DESIGN.md and the handler. */

export const KEYMAP_HELP = [
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
  ["g v/c/a/i/w/s", "Go to a section"],
] as const;

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
