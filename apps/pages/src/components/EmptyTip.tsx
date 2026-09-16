import type { ReactNode } from "react";
import { IconInfo } from "./Icons.js";

/**
 * Quiet tip under an empty-state heading.
 *
 * IconInfo + `.hint` sizing — same voice as field guidance, not a status
 * `.note` card. Keyboard tips hide on touch-primary pointers.
 */
export function EmptyTip({
  children,
  keys = true,
}: {
  children: ReactNode;
  /** When true (default), hide on coarse pointers where a keyboard is unlikely. */
  keys?: boolean;
}) {
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

/** Short keyboard tips for empty screens. Keep each one line. */
export const emptyTips = {
  navigate: "Try using your keyboard to navigate.",
  vaultMove: "Use the arrow keys or j/k to move through vault items.",
  vaultEmpty: "Try the keyboard — n new, / search, ? for every key.",
  rail: "j/k moves the rail · Enter opens · g then a letter jumps.",
  keymap: "Press ? to see every shortcut.",
  escBack: "Esc returns focus to the listing.",
} as const;
