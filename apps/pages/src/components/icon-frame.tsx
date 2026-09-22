/**
 * The frame every line icon is drawn in.
 *
 * Split out of `Icons.tsx` so the icon list can live in more than one file
 * without either copy owning the stroke, the viewbox or the title rule.
 * `Icons.tsx` re-exports `IconProps`, so no caller's import moved.
 */

import type { ReactNode } from "react";

export type IconProps = { className?: string; title?: string; size?: number };

export function Svg({
  className,
  title,
  size = 20,
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}
