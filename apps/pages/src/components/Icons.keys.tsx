/**
 * Glyphs for Settings › Keybindings (ADR 0150): the keyboard that records a
 * key, the dot that records a macro, and the two arrows that swap a key.
 * `Icons.tsx` re-exports every name here.
 */

import { type IconProps, Svg } from "./icon-frame.js";

/** A keyboard: search by pressing keys rather than typing words. */
export function IconKeyboard(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="6.5" width="18" height="11" rx="1.5" />
      <path d="M7 10.5h.01M10.3 10.5h.01M13.7 10.5h.01M17 10.5h.01M8.5 14h7" />
    </Svg>
  );
}

/** A ring around a dot: record what the keys do. */
export function IconRecord(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Two arrows passing: trade this key with whatever holds that one. */
export function IconSwap(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 8.5h14M15 5l3.5 3.5L15 12" />
      <path d="M19.5 15.5h-14M9 12l-3.5 3.5L9 19" />
    </Svg>
  );
}
