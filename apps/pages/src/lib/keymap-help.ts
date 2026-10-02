/** In-app `?` sheet rows — must stay in lockstep with DESIGN.md and the handler. */

import { contributionsSnapshot } from "@opensesame/app-core/lib/contributions.js";

/**
 * Every row but the section jumps, which depend on what is registered. The
 * `GATED` rows are dropped unless their capability contributed the control.
 */
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
  ["s", "Share"],
  ["qa … q  @a  @@", "Record or replay a macro"],
  ["Shift-F10 / Shift-Enter", "Actions for the focused row"],
] as const;

export type KeymapHelpRow = readonly [keys: string, action: string];

/** The `g` row spells out exactly the jumps that exist: `g v/s` on a core-only plan. */
export function keymapJumpHelpRow(jumpKeys: readonly string[]): KeymapHelpRow {
  return [`g ${jumpKeys.join("/")}`, "Go to a section"];
}

/** What a capability brought that the sheet names: its row shows only then. */
export type KeymapExtras = Readonly<{ voice: boolean; share: boolean }>;

const NO_EXTRAS: KeymapExtras = { voice: false, share: false };

/** The extras registered right now: a voice control, a way to share. */
export function contributedKeymapExtras(): KeymapExtras {
  return {
    voice: contributionsSnapshot("command-assist").some(
      (assist) => assist.Voice !== undefined,
    ),
    share: contributionsSnapshot("secret-share").length > 0,
  };
}

/** `m` belongs to the on-device model's voice, `s` to secret drops. */
const GATED = new Map<string, keyof KeymapExtras>([
  ["m", "voice"],
  ["s", "share"],
]);

/** The whole sheet for a given set of registered jump keys and extras. */
export function keymapHelpRows(
  jumpKeys: readonly string[],
  extras: KeymapExtras = NO_EXTRAS,
): readonly KeymapHelpRow[] {
  const rows = KEYMAP_HELP_CORE.filter(([keys]) => {
    const gate = GATED.get(keys);
    return gate === undefined || extras[gate];
  });
  return [...rows, keymapJumpHelpRow(jumpKeys)];
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
