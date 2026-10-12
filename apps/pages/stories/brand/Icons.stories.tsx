import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentType } from "react";
import {
  IconAddSquare,
  IconAlert,
  IconArrowRight,
  IconAuthority,
  IconBell,
  IconCard,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconClock,
  IconConnection,
  IconCopy,
  IconDots,
  IconDotsVertical,
  IconDownload,
  IconDrop,
  IconEdit,
  IconExternal,
  IconEye,
  IconEyeOff,
  IconFilter,
  IconFolder,
  IconGitBranch,
  IconHelp,
  IconIOSShare,
  IconInfo,
  IconKeyboard,
  IconLayers,
  IconLock,
  IconLogin,
  IconMail,
  IconMark,
  IconMenu,
  IconMessage,
  IconMonitor,
  IconMoon,
  IconNote,
  IconPasskey,
  IconPause,
  IconPhone,
  IconPlay,
  IconPlus,
  type IconProps,
  IconRecord,
  IconRefresh,
  IconSearch,
  IconSecret,
  IconSettings,
  IconShare,
  IconShield,
  IconSignOut,
  IconSite,
  IconSkip,
  IconSkipAll,
  IconStar,
  IconSun,
  IconSupport,
  IconSwap,
  IconTerminal,
  IconTrash,
  IconUpload,
  IconUser,
  IconVault,
  IconX,
} from "../../src/components/Icons.js";

/**
 * Every glyph the app draws, from `components/Icons*.tsx`: one family, one
 * stroke, drawn in `currentColor` so a glyph is ink on a key and canvas on
 * an armed one. A verb is never painted on a key; the glyph is the key.
 * The list is written out so a new icon is added here on purpose.
 */
const ICONS: readonly (readonly [string, ComponentType<IconProps>])[] = [
  ["IconAddSquare", IconAddSquare],
  ["IconAlert", IconAlert],
  ["IconArrowRight", IconArrowRight],
  ["IconAuthority", IconAuthority],
  ["IconBell", IconBell],
  ["IconCard", IconCard],
  ["IconCheck", IconCheck],
  ["IconChevronDown", IconChevronDown],
  ["IconChevronLeft", IconChevronLeft],
  ["IconChevronRight", IconChevronRight],
  ["IconChevronUp", IconChevronUp],
  ["IconClock", IconClock],
  ["IconConnection", IconConnection],
  ["IconCopy", IconCopy],
  ["IconDots", IconDots],
  ["IconDotsVertical", IconDotsVertical],
  ["IconDownload", IconDownload],
  ["IconDrop", IconDrop],
  ["IconEdit", IconEdit],
  ["IconExternal", IconExternal],
  ["IconEye", IconEye],
  ["IconEyeOff", IconEyeOff],
  ["IconFilter", IconFilter],
  ["IconFolder", IconFolder],
  ["IconGitBranch", IconGitBranch],
  ["IconHelp", IconHelp],
  ["IconIOSShare", IconIOSShare],
  ["IconInfo", IconInfo],
  ["IconKeyboard", IconKeyboard],
  ["IconLayers", IconLayers],
  ["IconLock", IconLock],
  ["IconLogin", IconLogin],
  ["IconMail", IconMail],
  ["IconMark", IconMark],
  ["IconMenu", IconMenu],
  ["IconMessage", IconMessage],
  ["IconMonitor", IconMonitor],
  ["IconMoon", IconMoon],
  ["IconNote", IconNote],
  ["IconPasskey", IconPasskey],
  ["IconPause", IconPause],
  ["IconPhone", IconPhone],
  ["IconPlay", IconPlay],
  ["IconPlus", IconPlus],
  ["IconRecord", IconRecord],
  ["IconRefresh", IconRefresh],
  ["IconSearch", IconSearch],
  ["IconSecret", IconSecret],
  ["IconSettings", IconSettings],
  ["IconShare", IconShare],
  ["IconShield", IconShield],
  ["IconSignOut", IconSignOut],
  ["IconSite", IconSite],
  ["IconSkip", IconSkip],
  ["IconSkipAll", IconSkipAll],
  ["IconStar", IconStar],
  ["IconSun", IconSun],
  ["IconSupport", IconSupport],
  ["IconSwap", IconSwap],
  ["IconTerminal", IconTerminal],
  ["IconTrash", IconTrash],
  ["IconUpload", IconUpload],
  ["IconUser", IconUser],
  ["IconVault", IconVault],
  ["IconX", IconX],
];

function Gallery({ size }: { size: number }) {
  return (
    <ul
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))",
        gap: 12,
        listStyle: "none",
        margin: 0,
        padding: 0,
      }}
    >
      {ICONS.map(([name, Icon]) => (
        <li
          key={name}
          style={{
            display: "grid",
            justifyItems: "center",
            gap: 8,
            padding: 12,
            border: "1px solid var(--line)",
            font: "11px ui-monospace, monospace",
            color: "var(--ink-2)",
          }}
        >
          <Icon size={size} title={name} />
          <span>{name.slice(4)}</span>
        </li>
      ))}
    </ul>
  );
}

const meta = {
  title: "Brand/Icons",
  component: Gallery,
  tags: ["autodocs", "ai-generated"],
  args: { size: 20 },
  argTypes: { size: { control: { type: "number", min: 12, max: 48 } } },
} satisfies Meta<typeof Gallery>;

export default meta;
type Story = StoryObj<typeof meta>;

export const All: Story = {};
