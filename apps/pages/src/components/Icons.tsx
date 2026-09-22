import type { ComponentType } from "react";
import type { IconName } from "../lib/capabilities/runtime-contract.js";
import { type IconProps, Svg } from "./icon-frame.js";
import {
  IconShield,
  IconLock,
  IconClock,
  IconFolder,
  IconStar,
  IconSupport,
  IconHelp,
  IconInfo,
  IconAlert,
} from "./Icons.actions.js";

export type { IconProps };
export {
  IconSearch,
  IconStar,
  IconEdit,
  IconArrowRight,
  IconTrash,
  IconPlus,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconRefresh,
  IconCheck,
  IconX,
  IconChevronRight,
  IconChevronLeft,
  IconSkip,
  IconSkipAll,
  IconDots,
  IconMenu,
  IconFilter,
  IconFolder,
  IconShield,
  IconAlert,
  IconInfo,
  IconSupport,
  IconHelp,
  IconLock,
  IconExternal,
  IconDownload,
  IconUpload,
  IconDrop,
  IconClock,
  IconTerminal,
  IconSun,
  IconMoon,
  IconMonitor,
} from "./Icons.actions.js";

/* —— Brand ———————————————————————————————————————————————————
   The mark is the door ajar: the vault slab slid aside, a slit of light
   where it opened. Ink slab, accent light — the one place the accent is
   identity rather than state. */

export function IconMark({ className, title, size = 20 }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      <rect x="3.5" y="3.5" width="12" height="17" fill="currentColor" />
      <rect
        x="18.2"
        y="3.5"
        width="2.3"
        height="17"
        fill="var(--accent, #0d7268)"
      />
    </svg>
  );
}

/* —— Sections ——————————————————————————————————————————————— */

export function IconVault(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5" y="10.5" width="14" height="10.5" rx="2.2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
      <circle cx="12" cy="15.5" r="1.15" />
      <path d="M12 16.65V18" />
    </Svg>
  );
}

export function IconSite(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5a13 13 0 0 1 0 17 13 13 0 0 1 0-17z" />
    </Svg>
  );
}

export function IconConnection(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10.2 13.8a4.6 4.6 0 0 0 6.94.5l2.6-2.6a4.6 4.6 0 0 0-6.5-6.5l-1.5 1.49" />
      <path d="M13.8 10.2a4.6 4.6 0 0 0-6.94-.5l-2.6 2.6a4.6 4.6 0 0 0 6.5 6.5l1.49-1.49" />
    </Svg>
  );
}

export function IconAuthority(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3l7.5 3.2v5.1c0 4.7-3.1 8.1-7.5 9.4-4.4-1.3-7.5-4.7-7.5-9.4V6.2z" />
      <path d="M9.2 12.1l2 2 3.6-3.9" />
    </Svg>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" />
    </Svg>
  );
}

/* —— Item kinds ————————————————————————————————————————————— */

export function IconBell(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.2 9.2a5.8 5.8 0 0 1 11.6 0c0 4.2 1.4 5.6 1.4 5.6H4.8s1.4-1.4 1.4-5.6Z" />
      <path d="M10 18.4a2 2 0 0 0 4 0" />
    </Svg>
  );
}

export function IconLogin(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8.5" cy="12" r="4" />
      <path d="M12.5 12H21M18 12v3M15 12v2.2" />
    </Svg>
  );
}

export function IconUser(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5.2 19.2c1.1-3.2 3.5-4.8 6.8-4.8s5.7 1.6 6.8 4.8" />
    </Svg>
  );
}

export function IconPasskey(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 20c-.6-1.6-.9-3.2-.9-4.9a5.9 5.9 0 0 1 11.8 0" />
      <path d="M12 15.1c0 2 .3 3.6.9 4.9" />
      <path d="M3.9 9.4A9.1 9.1 0 0 1 12 4.5a9.1 9.1 0 0 1 8.1 4.9" />
      <path d="M9.4 15.1a2.6 2.6 0 0 1 5.2 0c0 1.4.2 2.6.6 3.7" />
    </Svg>
  );
}

export function IconCard(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.75" y="5.5" width="18.5" height="13" rx="2.5" />
      <path d="M2.75 10h18.5M6.5 14.6h3.2" />
    </Svg>
  );
}

export function IconSecret(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M7.5 9.5l2.6 2.5-2.6 2.5M12.8 15h4" />
    </Svg>
  );
}

export function IconNote(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 3.5h8.2L18.5 8v12.5H6z" />
      <path d="M13.8 3.5v4.2h4.2M9 12.5h6.5M9 16h4.5" />
    </Svg>
  );
}

/* —— Connectivity bar ———————————————————————————————————————— */

/** Git history: a branch, because the remote is what the capability binds. */
export function IconGitBranch(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="7" cy="6" r="2.2" />
      <circle cx="7" cy="18" r="2.2" />
      <circle cx="17" cy="9" r="2.2" />
      <path d="M7 8.2v7.6" />
      <path d="M17 11.2c0 3.4-3 4.4-5.6 4.8" />
    </Svg>
  );
}

/** TaskBus / NATS: concentric broadcast arcs. */
export function IconBroadcast(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="2" />
      <path d="M8.3 8.3a5.2 5.2 0 0 0 0 7.4M15.7 15.7a5.2 5.2 0 0 0 0-7.4" />
      <path d="M5.6 5.6a9 9 0 0 0 0 12.8M18.4 18.4a9 9 0 0 0 0-12.8" />
    </Svg>
  );
}

/** A phone, for the Mobile MFA hand-off. */
export function IconMail(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="M4.5 7.5l7.5 5.5 7.5-5.5" />
    </Svg>
  );
}

export function IconMessage(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 5.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8.2L7.5 19.8v-3.3h-3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" />
    </Svg>
  );
}

export function IconPhone(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M11 18.5h2" />
    </Svg>
  );
}

/* —— Install ————————————————————————————————————————————————— */

/**
 * iOS Share — the exact glyph the reader is hunting for in Safari's toolbar.
 * Drawn rather than described, because "the share button" is three different
 * shapes across the platforms this app runs on.
 */
export function IconShare(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5v10.5" />
      <path d="M8.5 7L12 3.5 15.5 7" />
      <path d="M8 10.5H6.2A1.7 1.7 0 0 0 4.5 12.2v6.6A1.7 1.7 0 0 0 6.2 20.5h11.6a1.7 1.7 0 0 0 1.7-1.7v-6.6a1.7 1.7 0 0 0-1.7-1.7H16" />
    </Svg>
  );
}

/** "Add to Home Screen" — the plus-in-a-square beside that row in the sheet. */
export function IconAddSquare(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <path d="M12 8.5v7M8.5 12h7" />
    </Svg>
  );
}

export type { IconName };

/**
 * Icons by the string key a capability module names in its contributions
 * (`section.icon`). A module ships no SVG the core has to trust; the shell
 * resolves the key here, and a key this table lacks is a type error.
 */
export const ICONS_BY_NAME: Record<IconName, ComponentType<IconProps>> = {
  vault: IconVault,
  site: IconSite,
  connection: IconConnection,
  authority: IconAuthority,
  settings: IconSettings,
  bell: IconBell,
  login: IconLogin,
  user: IconUser,
  passkey: IconPasskey,
  card: IconCard,
  secret: IconSecret,
  note: IconNote,
  shield: IconShield,
  lock: IconLock,
  clock: IconClock,
  folder: IconFolder,
  star: IconStar,
  support: IconSupport,
  help: IconHelp,
  info: IconInfo,
  alert: IconAlert,
};
