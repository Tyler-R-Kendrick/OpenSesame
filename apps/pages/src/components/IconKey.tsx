import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

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
  keyRef,
  ...rest
}: {
  /** The sentence: the key's accessible name and its tooltip. */
  label: string;
  /** The glyph. */
  children: ReactNode;
  small?: boolean;
  danger?: boolean;
  keyRef?: Ref<HTMLButtonElement>;
} & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "title" | "className" | "children"
>) {
  const className = `icon-btn${small ? " icon-btn--sm" : ""}${danger ? " icon-btn--danger" : ""}`;
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
