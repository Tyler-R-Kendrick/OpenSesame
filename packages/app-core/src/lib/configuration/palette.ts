import { REGISTERED_ACTIONS } from "./actions.js";
import { PREFS_DISPLAY_PATH } from "./aliases.js";

export type PaletteHit = {
  id: string;
  label: string;
  href?: string;
  shortcut?: string;
  kind: "action" | "setting" | "application";
};

const SETTING_KEYS: readonly PaletteHit[] = [
  {
    id: "setting.theme",
    label: "theme",
    href: "/settings",
    kind: "setting",
  },
  {
    id: "setting.autoLockMinutes",
    label: "autoLockMinutes",
    href: "/settings",
    kind: "setting",
  },
  {
    id: "setting.prefs",
    label: PREFS_DISPLAY_PATH,
    href: "/settings",
    kind: "setting",
  },
];

function matches(haystack: string, query: string): boolean {
  return haystack.toLowerCase().includes(query.toLowerCase());
}

/**
 * Search authorized safe metadata only. Callers must pass applications already
 * filtered to the current scope; this function never reads concealed fields.
 */
export function searchPalette(input: {
  query: string;
  applications?: readonly { id: string; name: string; href: string }[];
}): PaletteHit[] {
  const query = input.query.trim();
  if (query === "") return [];
  const hits: PaletteHit[] = [];
  for (const action of REGISTERED_ACTIONS) {
    if (matches(action.label, query) || matches(action.id, query)) {
      hits.push({
        id: action.id,
        label: action.label,
        shortcut: action.defaultKeys[0],
        kind: "action",
      });
    }
  }
  for (const setting of SETTING_KEYS) {
    if (matches(setting.label, query) || matches(setting.id, query)) {
      hits.push(setting);
    }
  }
  for (const application of input.applications ?? []) {
    if (matches(application.name, query)) {
      hits.push({
        id: `app:${application.id}`,
        label: application.name,
        href: application.href,
        kind: "application",
      });
    }
  }
  return hits.slice(0, 20);
}
