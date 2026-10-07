import { setTheme, themeLabel, useThemePreference } from "../lib/theme.js";
import { IconMonitor, IconMoon, IconSun } from "./Icons.js";

const choices = [
  { theme: "light", Icon: IconSun },
  { theme: "dark", Icon: IconMoon },
  { theme: "system", Icon: IconMonitor },
] as const;

export function AppearanceChoices() {
  const selected = useThemePreference();
  return (
    <fieldset className="more__appearance" aria-label="Appearance">
      {choices.map(({ theme, Icon }) => (
        <button
          key={theme}
          type="button"
          className="more__theme"
          aria-pressed={selected === theme}
          onClick={() => setTheme(theme)}
        >
          <Icon size={18} />
          <span>{themeLabel(theme)}</span>
        </button>
      ))}
    </fieldset>
  );
}
