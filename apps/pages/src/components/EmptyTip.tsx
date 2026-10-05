import type { ReactNode } from "react";
import { keymapLabel } from "../lib/gestures.js";
import { IconInfo } from "./Icons.js";

/** Short keyboard tips for empty screens. Keep each one line. */
export const emptyTips = {
  navigate: "Try using your keyboard to navigate.",
  vaultMove: "Use the arrow keys or j/k to move through vault items.",
  vaultEmpty: "Try the keyboard — n new, / search, ? for every key.",
  rail: "j/k moves the rail · Enter opens · g then a letter jumps.",
  keymap: "Press ? to see every shortcut.",
  escBack: "Esc returns focus to the listing.",
} as const;

export type EmptyTipKey = keyof typeof emptyTips;

export function isEmptyTipKey(key: string): key is EmptyTipKey {
  return Object.hasOwn(emptyTips, key);
}

export const emptyTipKeys: readonly EmptyTipKey[] =
  Object.keys(emptyTips).filter(isEmptyTipKey);

/**
 * What each keyboard tip says where the pointer is a finger, keyed as
 * `emptyTips` is so a call site names the tip and gets both voices.
 */
export const touchTips = {
  navigate: "Tap a row to open it.",
  vaultMove: "Tap an item to open it.",
  vaultEmpty: "The + button adds the first item.",
  rail: "The menu key at the top opens every section.",
  // Names the ⋯ menu's own row (`keymapLabel`), not the one that opens Support.
  keymap: `${keymapLabel(true)} in the ⋯ menu lists every gesture.`,
  escBack: "Swipe right to go back.",
} satisfies Record<EmptyTipKey, string>;

/**
 * Quiet tip under an empty-state heading.
 *
 * IconInfo + `.hint` sizing — same voice as field guidance, not a status
 * `.note` card. A keyboard tip is drawn in both voices — `tip="keymap"` — and
 * CSS shows the keys beside a keyboard and the touch twin under a finger;
 * custom children are keys only and hide on a coarse pointer (`keys={false}`
 * for a tip that is not about keys at all).
 */
export function EmptyTip({
  tip,
  children,
  keys = true,
}: {
  tip?: EmptyTipKey;
  children?: ReactNode;
  /** When true (default), hide on coarse pointers where a keyboard is unlikely. */
  keys?: boolean;
}) {
  if (tip !== undefined) {
    return (
      <p className="empty__tip" role="note">
        <IconInfo size={14} aria-hidden="true" />
        <span className="empty__tip-keys">{emptyTips[tip]}</span>
        <span className="empty__tip-touch">{touchTips[tip]}</span>
      </p>
    );
  }
  return (
    <p
      className={keys ? "empty__tip empty__tip--keys" : "empty__tip"}
      role="note"
    >
      <IconInfo size={14} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}
