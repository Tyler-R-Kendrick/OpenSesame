/** In-app `?` sheet rows — must stay in lockstep with DESIGN.md and the handler. */

import { contributionsSnapshot } from "@opensesame/app-core/lib/contributions.js";
import {
  type KeymapView,
  effectiveRows,
  liveJumpKeys,
  yourRows,
} from "./keymap-help-rows.js";
import {
  HELP_SOURCES,
  KEYMAP_HELP_CORE,
  type KeymapExtras,
  type KeymapHelpRow,
  offeredSources,
} from "./keymap-help-sources.js";

export { KEYMAP_HELP_CORE, type KeymapExtras, type KeymapHelpRow };
export type { KeymapView };

/** The `g` row spells out exactly the jumps that exist: `g v/s` on a core-only plan. */
export function keymapJumpHelpRow(jumpKeys: readonly string[]): KeymapHelpRow {
  return [`g ${jumpKeys.join("/")}`, "Go to a section"];
}

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

/**
 * The whole sheet for a given set of registered jump keys and extras. With a
 * `view` of the keymap in force, rows are drawn from its effective bindings
 * (a moved or unbound key changes its row) and the person's own keys for
 * anything else follow; without one it is the defaults as authored.
 */
export function keymapHelpRows(
  jumpKeys: readonly string[],
  extras: KeymapExtras = NO_EXTRAS,
  view?: KeymapView,
): readonly KeymapHelpRow[] {
  const sources = offeredSources(extras);
  if (view === undefined) {
    return [
      ...sources.map(({ keys, action }) => [keys, action] as const),
      keymapJumpHelpRow(jumpKeys),
    ];
  }
  const jumps = liveJumpKeys(jumpKeys, view);
  const covered = new Set(HELP_SOURCES.flatMap((source) => source.commands));
  return [
    ...effectiveRows(sources, view),
    ...(jumps.length > 0 ? [keymapJumpHelpRow(jumps)] : []),
    ...yourRows(view, covered),
  ];
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
