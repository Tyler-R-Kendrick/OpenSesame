/**
 * Day / night / system cycle control for chrome (statusline, More, unlock).
 */

import {
  cycleTheme,
  nextThemeLabel,
  themeLabel,
  useThemePreference,
} from "../lib/theme.js";
import { IconMonitor, IconMoon, IconSun } from "./Icons.js";

type Props = {
  /** Extra class on the icon button (e.g. unlock chrome). */
  className?: string;
  /** Omit from sequential focus when the control is chrome-only. */
  tabIndex?: number;
};

export function ThemeToggle({ className, tabIndex }: Props) {
  const theme = useThemePreference();
  const Icon =
    theme === "light" ? IconSun : theme === "dark" ? IconMoon : IconMonitor;
  const next = nextThemeLabel(theme);
  const label = `Theme: ${themeLabel(theme)}. Switch to ${next}.`;
  return (
    <button
      type="button"
      className={className ? `icon-btn ${className}` : "icon-btn"}
      aria-label={label}
      title={label}
      tabIndex={tabIndex}
      onClick={() => {
        cycleTheme(theme);
      }}
    >
      <Icon size={18} />
    </button>
  );
}
