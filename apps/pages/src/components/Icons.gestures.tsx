/**
 * Glyphs for Settings › Keybindings › Gestures (ADR 0168): two fingers moving
 * (the dots trail the arrow), two fingers tapping (a ring about each), and a
 * phone shaken. The swipes are one glyph turned, so the dots always sit where
 * the fingers started.
 */

import type { GestureId } from "@opensesame/app-core/lib/keymap/gestures.js";
import { type IconProps, Svg } from "./icon-frame.js";

const TURN = {
  "two-finger-swipe-up": 0,
  "two-finger-swipe-right": 90,
  "two-finger-swipe-down": 180,
  "two-finger-swipe-left": 270,
} as const;

/** A phone with a swing either side of it: the shake. */
export function IconShake(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="8" y="4.5" width="8" height="15" rx="1.5" />
      <path d="M4.5 9.5v5M2.5 11v2M19.5 9.5v5M21.5 11v2" />
    </Svg>
  );
}

/** The glyph a gesture is drawn with on its row. */
export function GestureGlyph({ id, ...props }: IconProps & { id: GestureId }) {
  if (id === "shake") return <IconShake {...props} />;
  if (id === "two-finger-tap") {
    return (
      <Svg {...props}>
        <circle cx="7.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="16.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="7.5" cy="12" r="4" />
        <circle cx="16.5" cy="12" r="4" />
      </Svg>
    );
  }
  return (
    <Svg {...props}>
      <g transform={`rotate(${TURN[id]} 12 12)`}>
        <circle cx="9.5" cy="17" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="14.5" cy="17" r="1.6" fill="currentColor" stroke="none" />
        <path d="M12 13V5M8.5 8.5 12 5l3.5 3.5" />
      </g>
    </Svg>
  );
}
