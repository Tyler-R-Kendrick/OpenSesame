import { searchPalette } from "../configuration/palette.js";
import { lookupConfigResource } from "../configuration/registry.js";
import { isSettingsCategory, settingsConfigRoute } from "../crumbs.js";
import {
  type AppCommand,
  CLAIM_COMMAND_PATH,
  type InterpretResult,
  JOIN_COMMAND_PATH,
  commandSections,
} from "./types.js";

const SECTION_ALIASES: ReadonlyArray<{
  path: Extract<AppCommand, { action: "navigate" }>["path"];
  words: readonly string[];
}> = [
  {
    path: "/vault",
    words: ["vault", "passwords", "logins", "accounts", "items"],
  },
  {
    path: "/connections",
    words: ["connections", "connectors", "services"],
  },
  { path: "/access", words: ["access", "grants", "approvals", "sessions"] },
  { path: "/identity", words: ["identity", "account", "sign in", "signin"] },
  { path: "/settings", words: ["settings", "prefs", "preferences"] },
  {
    path: CLAIM_COMMAND_PATH,
    words: ["claim", "claims", "drop", "drops"],
  },
  {
    path: JOIN_COMMAND_PATH,
    words: ["join", "join a session"],
  },
];

const FIELD_ALIASES: ReadonlyArray<{
  field: Extract<AppCommand, { action: "copy_field" }>["field"];
  words: readonly string[];
}> = [
  { field: "password", words: ["password", "secret", "pass"] },
  { field: "rest", words: ["rest", "ending", "tail"] },
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
        lower === `open a ${word}` ||
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
    /^(?:copy|get|grab)\s+(password|secret|pass|rest|ending|tail|username|user|email|login|otp|code|totp|2fa|mfa|url|site|website|link)\s+(?:for|of|from)?\s*(.+)$/i,
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
 * The words after `/?` or `/search` while the field holds that verb, so a
 * listing can narrow as they are typed instead of waiting for Enter. `""` is
 * the verb with nothing after it yet; `null` is any other text, and a bare
 * `/?` with no space after it, which is still help.
 */
export function liveSearchOf(raw: string): string | null {
  const match = /^\s*\/(?:search|\?)\s(.*)$/i.exec(raw);
  return match ? (match[1] ?? "").replace(/^\s+/, "") : null;
}

/**
 * Deterministic NL → command. Runs before any model so offline / no-Prompt-API
 * devices still get Discord-style voice control for the common verbs.
 */
export function parseCommand(raw: string): AppCommand | null {
  const text = raw.trim().replace(/\s+/g, " ");
  if (text === "") return null;
  if (text.startsWith("/")) {
    return parseSlash(text) ?? parseResourcePath(text) ?? parsePalette(text);
  }
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

const SLASH_DESTINATION = /^\/[a-z0-9-]+(?:\?[a-z0-9._=&%-]+)?$/i;

/**
 * `/vault`, `/search …`, `/? …`, `/copy password …`. Sentences stay on the
 * other parsers. A bare `/?` is help; with words after it, `?` is the short
 * name for search, the one the `/` key writes into the field.
 */
function parseSlash(text: string): AppCommand | null {
  const body = text.slice(1).trim();
  if (body === "") return null;
  if (body.toLowerCase() === "help" || body === "?") return { action: "help" };
  return (
    parseCopy(body) ??
    parseSlashSearch(body) ??
    parseSlashOpen(body) ??
    parseSlashDestination(body)
  );
}

function parseSlashSearch(body: string): AppCommand | null {
  const query = /^(?:search|\?)\s+(.+)$/i.exec(body)?.[1]?.trim() ?? "";
  if (query === "") return null;
  return { action: "search", query };
}

function parseSlashOpen(body: string): AppCommand | null {
  const query = /^open\s+(.+)$/i.exec(body)?.[1]?.trim() ?? "";
  if (query === "") return null;
  const pathCommand = parseResourcePath(query);
  if (pathCommand) return pathCommand;
  const section = SECTION_ALIASES.find((entry) =>
    entry.words.includes(query.toLowerCase()),
  );
  if (section) return { action: "navigate", path: section.path };
  return { action: "open_item", query };
}

function parseSlashDestination(body: string): AppCommand | null {
  const path = `/${body}`;
  if (!SLASH_DESTINATION.test(path)) return null;
  const exact = commandSections().find(
    (section) => section.toLowerCase() === path.toLowerCase(),
  );
  if (exact) return { action: "navigate", path: exact };
  const alias = SECTION_ALIASES.find((entry) =>
    entry.words.includes(body.toLowerCase()),
  );
  if (alias) return { action: "navigate", path: alias.path };
  return { action: "navigate", path };
}

function parsePalette(text: string): AppCommand | null {
  const hits = searchPalette({ query: text });
  const setting = hits.find((hit) => hit.kind === "setting" && hit.href);
  if (!setting?.href) return null;
  return { action: "open_path", path: setting.href, label: setting.label };
}

/**
 * The parser alone: how the command bar reads an utterance when no
 * `command-assist` contribution (the on-device model) is there to ask.
 */
export function readCommand(utterance: string): InterpretResult {
  const trimmed = utterance.trim();
  if (trimmed === "") return { source: "none", reason: "Empty command." };
  const parsed = parseCommand(trimmed);
  return parsed !== null
    ? { source: "parse", command: parsed }
    : {
        source: "none",
        reason: "No match. Try “copy password for …” or “go to vault”.",
      };
}
