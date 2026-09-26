/**
 * Actions, affordances and state glyphs — the working half of the icon set.
 *
 * Split out of `Icons.tsx` at its own section boundary when that file crossed
 * the module-size budget (ADR 0093). `Icons.tsx` re-exports every name here,
 * so an importer's path is unchanged.
 */

import { type IconProps, Svg } from "./icon-frame.js";

/* —— Actions and affordances ———————————————————————————————— */

export function IconSearch(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="M19.5 19.5l-4.2-4.2" />
    </Svg>
  );
}

export function IconStar({
  filled,
  ...props
}: IconProps & { filled?: boolean }) {
  return (
    <svg
      className={props.className}
      width={props.size ?? 20}
      height={props.size ?? 20}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={props.title ? undefined : true}
      role={props.title ? "img" : undefined}
    >
      {props.title ? <title>{props.title}</title> : null}
      <path d="M12 3.8l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" />
    </svg>
  );
}

export function IconEdit(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 19.5l.9-3.6L16.6 4.7a1.9 1.9 0 0 1 2.7 2.7L8.1 18.6z" />
      <path d="M14.8 6.5l2.7 2.7" />
    </Svg>
  );
}

export function IconArrowRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 12h15M13 5.5l6.5 6.5L13 18.5" />
    </Svg>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 6.5h15M9.5 6.5V4.8h5v1.7M6.5 6.5l.9 12.2a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12.2" />
      <path d="M10.3 10.3v6M13.7 10.3v6" />
    </Svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5.5v13M5.5 12h13" />
    </Svg>
  );
}

export function IconCopy(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2.2" />
      <path d="M15 9V6.2A2.2 2.2 0 0 0 12.8 4H6.2A2.2 2.2 0 0 0 4 6.2v6.6A2.2 2.2 0 0 0 6.2 15H9" />
    </Svg>
  );
}

export function IconEye(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </Svg>
  );
}

export function IconEyeOff(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.6 6.2A9.6 9.6 0 0 1 12 5.8c6 0 9.5 6.2 9.5 6.2a17 17 0 0 1-3 3.8M6.4 8.1A17 17 0 0 0 2.5 12S6 18.2 12 18.2a9.4 9.4 0 0 0 3.4-.6" />
      <path d="M10 10.1a2.8 2.8 0 0 0 3.9 3.9M4 4l16 16" />
    </Svg>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 11.5a8 8 0 1 0-.7 4.5" />
      <path d="M20 5.5v5h-5" />
    </Svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </Svg>
  );
}

export function IconX(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.5 5.5l6.5 6.5-6.5 6.5" />
    </Svg>
  );
}

export function IconChevronLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14.5 5.5L8 12l6.5 6.5" />
    </Svg>
  );
}

/** Earlier in an order. */
export function IconChevronUp(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5.5 14.5L12 8l6.5 6.5" />
    </Svg>
  );
}

/** Later in an order. */
export function IconChevronDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5.5 9.5L12 16l6.5-6.5" />
    </Svg>
  );
}

/** Skip one step — chevron past a stop. */
export function IconSkip(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 5.5l6.5 6.5L7 18.5" />
      <path d="M16.5 5.5v13" />
    </Svg>
  );
}

/** Skip the rest — double chevron. */
export function IconSkipAll(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 5.5L11 12l-6.5 6.5" />
      <path d="M11.5 5.5L18 12l-6.5 6.5" />
    </Svg>
  );
}

export function IconDots(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="5.5" cy="12" r="0.6" fill="currentColor" />
      <circle cx="12" cy="12" r="0.6" fill="currentColor" />
      <circle cx="18.5" cy="12" r="0.6" fill="currentColor" />
    </Svg>
  );
}

export function IconMenu(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  );
}

export function IconFilter(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6h16l-6.2 7.1v5.2l-3.6 1.8v-7z" />
    </Svg>
  );
}

export function IconFolder(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 7a2 2 0 0 1 2-2h3.3l1.8 2.3h7.9a2 2 0 0 1 2 2v7.7a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z" />
    </Svg>
  );
}

export function IconShield(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3l7.5 3.2v5.1c0 4.7-3.1 8.1-7.5 9.4-4.4-1.3-7.5-4.7-7.5-9.4V6.2z" />
    </Svg>
  );
}

export function IconAlert(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.8v4.7M12 16h.01" />
    </Svg>
  );
}

export function IconInfo(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11.2v5M12 8h.01" />
    </Svg>
  );
}

/** Support: a question asked in the room, not a mascot in a bubble. */
export function IconSupport(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 12.2a7.6 7.6 0 0 1-11.2 6.7L4.2 20l1.2-4.4A7.6 7.6 0 1 1 20 12.2Z" />
      <path d="M10.1 9.9a2 2 0 1 1 2.85 2.1c-.62.34-1 .8-1 1.5" />
      <path d="M11.95 16.1h.01" />
    </Svg>
  );
}

/** The overlay mark: a question, not a chat bubble. */
export function IconHelp(props: IconProps) {
  return (
    <Svg {...props}>
      {/* Circled, so the mark reads as help at 15px; bare, it was a 4px
          question mark beside full-size glyphs. */}
      <circle cx="12" cy="12" r="9" />
      <path d="M9.05 9.1a3 3 0 1 1 4.15 2.8c-.7.4-1.15.95-1.15 1.75" />
      <path d="M12 17.15h.01" />
    </Svg>
  );
}

export function IconLock(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5" y="10.5" width="14" height="10.5" rx="2.2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </Svg>
  );
}

export function IconExternal(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.5 4.5H19.5V10.5" />
      <path d="M19.5 4.5L11 13" />
      <path d="M18 14v4.3a1.7 1.7 0 0 1-1.7 1.7H5.7A1.7 1.7 0 0 1 4 18.3V7.7A1.7 1.7 0 0 1 5.7 6H10" />
    </Svg>
  );
}

export function IconDownload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4v10.5M7.5 10.5L12 15l4.5-4.5" />
      <path d="M4.5 17.5v1.2a1.8 1.8 0 0 0 1.8 1.8h11.4a1.8 1.8 0 0 0 1.8-1.8v-1.2" />
    </Svg>
  );
}

export function IconUpload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 20V9.5M7.5 13.5L12 9l4.5 4.5" />
      <path d="M4.5 6.5V5.3A1.8 1.8 0 0 1 6.3 3.5h11.4a1.8 1.8 0 0 1 1.8 1.8v1.2" />
    </Svg>
  );
}

export function IconDrop(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 3.5h10M7 20.5h10" />
      <path d="M8.5 3.5c0 3.2 1.8 4.7 3.5 5.7 1.7-1 3.5-2.5 3.5-5.7" />
      <path d="M8.5 20.5c0-3.2 1.8-4.7 3.5-5.7 1.7 1 3.5 2.5 3.5 5.7" />
    </Svg>
  );
}

export function IconClock(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.2V12l3.2 1.9" />
    </Svg>
  );
}

export function IconTerminal(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M7 9.5l2.8 2.5L7 14.5M12.5 15h4.2" />
    </Svg>
  );
}

export function IconSun(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.8v1.8M12 19.4v1.8M4.9 4.9l1.3 1.3M17.8 17.8l1.3 1.3M2.8 12h1.8M19.4 12h1.8M4.9 19.1l1.3-1.3M17.8 6.2l1.3-1.3" />
    </Svg>
  );
}

export function IconMoon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2z" />
    </Svg>
  );
}

export function IconMonitor(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M8.5 20h7M12 16.5V20" />
    </Svg>
  );
}

export function IconPause(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 6v12M15 6v12" />
    </Svg>
  );
}

export function IconPlay(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 5.5v13l10-6.5z" />
    </Svg>
  );
}

/** The door and the arrow leaving it: end this session. */
export function IconSignOut(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 4.5H6a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 6 19.5h4" />
      <path d="M14.5 8l4 4-4 4M18.5 12H9.5" />
    </Svg>
  );
}
