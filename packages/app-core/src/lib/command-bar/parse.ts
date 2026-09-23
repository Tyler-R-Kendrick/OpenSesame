import { searchPalette } from "../configuration/palette.js";
import { lookupConfigResource } from "../configuration/registry.js";
import { isSettingsCategory, settingsConfigRoute } from "../crumbs.js";
import type { AppCommand } from "./types.js";

const SECTION_ALIASES: ReadonlyArray<{
  path: Extract<AppCommand, { action: "navigate" }>["path"];
  words: readonly string[];
}> = [
  { path: "/vault", words: ["vault", "passwords", "logins", "items"] },
  {
    path: "/connections",
    words: ["connections", "connectors", "services"],
  },
  { path: "/access", words: ["access", "grants", "approvals", "sessions"] },
  { path: "/identity", words: ["identity", "account", "sign in", "signin"] },
  { path: "/settings", words: ["settings", "prefs", "preferences"] },
];

const FIELD_ALIASES: ReadonlyArray<{
  field: Extract<AppCommand, { action: "copy_field" }>["field"];
  words: readonly string[];
}> = [
  { field: "password", words: ["password", "secret", "pass"] },
  { field: "username", words: ["username", "user", "email", "login"] },
  { field: "otp", words: ["otp", "code", "totp", "2fa", "mfa"] },
  { field: "url", words: ["url", "site", "website", "link"] },
];

function parseNavigate(lower: string): AppCommand | null {
  for (const section of SECTION_ALIASES) {
    for (const word of section.words) {
      if (
        lower === word ||
        lower === `go to ${word}` ||
        lower === `open ${word}` ||
        lower === `show ${word}`
      ) {
        return { action: "navigate", path: section.path };
      }
    }
  }
  return null;
}

function parseCopy(text: string): AppCommand | null {
  const copy = text.match(
    /^(?:copy|get|grab)\s+(password|secret|pass|username|user|email|login|otp|code|totp|2fa|mfa|url|site|website|link)\s+(?:for|of|from)?\s*(.+)$/i,
  );
  if (!copy) return null;
  const fieldWord = copy[1]?.toLowerCase() ?? "";
  const query = (copy[2] ?? "").trim();
  const field = FIELD_ALIASES.find((entry) =>
    entry.words.includes(fieldWord),
  )?.field;
  if (field && query !== "") return { action: "copy_field", query, field };
  return null;
}

function refusePath(): AppCommand {
  return {
    action: "refuse",
    message: "That path is not an editable document.",
  };
}

function parseResourcePath(text: string): AppCommand | null {
  // A settings directory's own file, hidden in the rail but never closed.
  const config = /^\/?settings\/([a-z-]+)\/config\.ya?ml$/.exec(text);
  if (config?.[1] && isSettingsCategory(config[1])) {
    return {
      action: "open_path",
      path: settingsConfigRoute(config[1]),
      label: `settings/${config[1]}/config.yaml`,
    };
  }
  const lookup = lookupConfigResource(text);
  if (lookup.ok) {
    return { action: "open_path", path: "/settings", label: text };
  }
  if (lookup.reason === "forbidden") return refusePath();
  if (text.includes("/") || text.startsWith(".")) return refusePath();
  return null;
}

function parseOpenOrSearch(text: string): AppCommand | null {
  const open = text.match(/^(?:open|show|find)\s+(.+)$/i);
  if (open) {
    const query = (open[1] ?? "").trim();
    const queryLower = query.toLowerCase();
    const pathCommand = parseResourcePath(query);
    if (pathCommand) return pathCommand;
    if (
      query !== "" &&
      !SECTION_ALIASES.some((s) => s.words.includes(queryLower))
    ) {
      return { action: "open_item", query };
    }
  }
  const search = text.match(/^(?:search|look up|lookup)\s+(.+)$/i);
  if (search) {
    const query = (search[1] ?? "").trim();
    if (query !== "") return { action: "search", query };
  }
  return null;
}

/**
 * Deterministic NL → command. Runs before any model so offline / no-Prompt-API
 * devices still get Discord-style voice control for the common verbs.
 */
export function parseCommand(raw: string): AppCommand | null {
  const text = raw.trim().replace(/\s+/g, " ");
  if (text === "") return null;
  const lower = text.toLowerCase();
  if (/^(help|\?|what can you do)\b/.test(lower)) return { action: "help" };
  return (
    parseNavigate(lower) ??
    parseCopy(text) ??
    parseOpenOrSearch(text) ??
    parseResourcePath(text) ??
    parsePalette(text)
  );
}

function parsePalette(text: string): AppCommand | null {
  const hits = searchPalette({ query: text });
  const setting = hits.find((hit) => hit.kind === "setting" && hit.href);
  if (!setting?.href) return null;
  return { action: "open_path", path: setting.href, label: setting.label };
}
