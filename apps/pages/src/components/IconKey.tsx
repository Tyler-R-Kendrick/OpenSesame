import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { IconRefresh } from "./Icons.js";

/**
 * An icon key (docs/design/controls.md § 2): an action that executes, drawn
 * as a square whose sentence is its accessible name and its tooltip. The
 * label is written once, so the two can never disagree, and the verb is
 * never painted on the face.
 */
export function IconKey({
  label,
  children,
  small = false,
  danger = false,
  armed = false,
  keyRef,
  ...rest
}: {
  /** The sentence: the key's accessible name and its tooltip. */
  label: string;
  /** The glyph. */
  children: ReactNode;
  small?: boolean;
  danger?: boolean;
  /** A destructive key that one more press will fire. */
  armed?: boolean;
  keyRef?: Ref<HTMLButtonElement>;
} & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "title" | "className" | "children"
>) {
  const className = `icon-btn${small ? " icon-btn--sm" : ""}${danger ? " icon-btn--danger" : ""}${armed ? " is-armed" : ""}`;
  return (
    <button
      ref={keyRef}
      type="button"
      {...rest}
      className={className}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

/**
 * A panel head's reload: one size on every head. They were drawn at two —
 * a 20px glyph in a full key beside another panel's 15px small one.
 */
export function ReloadKey({
  label,
  onReload,
  disabled,
  keyRef,
}: {
  label: string;
  onReload: () => void;
  disabled?: boolean;
  keyRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <IconKey
      small
      label={label}
      keyRef={keyRef}
      disabled={disabled}
      onClick={onReload}
    >
      <IconRefresh size={15} />
    </IconKey>
  );
}
