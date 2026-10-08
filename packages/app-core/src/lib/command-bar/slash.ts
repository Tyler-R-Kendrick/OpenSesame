/**
 * Slash completions for the status-line command field.
 * Suggestions name commands and item names. They never carry a secret.
 */

import { liveSearchOf } from "./parse.js";
import {
  CLAIM_COMMAND_PATH,
  type CommandField,
  JOIN_COMMAND_PATH,
} from "./types.js";

export type SlashSuggestion = {
  id: string;
  /** Text written into the field when the row is accepted. */
  insert: string;
  label: string;
  /** A finished command runs. A prefix only fills the field. */
  run: boolean;
};

export type SlashSection = { path: string; label: string };

const LIMIT = 8;

const CORE_SECTIONS: readonly SlashSection[] = [
  { path: "/vault", label: "Vault" },
  { path: "/settings", label: "Settings" },
  { path: CLAIM_COMMAND_PATH, label: "Claim" },
  { path: JOIN_COMMAND_PATH, label: "Join" },
];

const VERBS: readonly SlashSuggestion[] = [
  { id: "help", insert: "/help", label: "Help", run: true },
  { id: "search", insert: "/search ", label: "Search", run: false },
  { id: "open", insert: "/open ", label: "Open", run: false },
  {
    id: "copy-password",
    insert: "/copy password ",
    label: "Copy password",
    run: false,
  },
  {
    id: "copy-username",
    insert: "/copy username ",
    label: "Copy username",
    run: false,
  },
  { id: "copy-otp", insert: "/copy otp ", label: "Copy code", run: false },
  { id: "copy-url", insert: "/copy url ", label: "Copy link", run: false },
];

/** A short name a verb answers to, typed after the slash: `/?` for search. */
const ALIASES: ReadonlyMap<string, string> = new Map([
  ["search", "/?"],
  // A drop link opens on the claim ceremony.
  [`go:${CLAIM_COMMAND_PATH}`, "/drop"],
]);

const LEAD_VERBS = new Set(["help", "search", "open", "copy-password"]);

const FIELD_WORDS: ReadonlyArray<{
  field: CommandField;
  words: readonly string[];
}> = [
  { field: "password", words: ["password", "secret", "pass"] },
  { field: "username", words: ["username", "user", "email", "login"] },
  { field: "otp", words: ["otp", "code", "totp", "2fa", "mfa"] },
  { field: "url", words: ["url", "site", "website", "link"] },
];

export type SuggestionAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "move"; index: number }
  | { type: "accept"; suggestion: SlashSuggestion };

/** Core destinations first, then every authorized command-path. */
export function slashSections(
  contributed: readonly SlashSection[],
  authorized: (path: string) => boolean = () => true,
): SlashSection[] {
  const rows = CORE_SECTIONS.filter((row) => authorized(row.path));
  const seen = new Set(rows.map((row) => row.path));
  for (const entry of contributed) {
    if (seen.has(entry.path) || !authorized(entry.path)) continue;
    seen.add(entry.path);
    rows.push({ path: entry.path, label: entry.label });
  }
  return rows;
}

/** Completions for a field value. Empty unless the value is a slash command. */
export function slashSuggestions(
  raw: string,
  sections: readonly SlashSection[],
  itemNames: readonly string[],
): readonly SlashSuggestion[] {
  const text = normalizeSlash(raw);
  if (!text.startsWith("/")) return [];
  const fromArgument = argumentSuggestions(text, itemNames);
  if (fromArgument !== null) return fromArgument;
  return commandSuggestions(text.toLowerCase(), sections);
}

/** Keyboard handling for the open list. The field keeps focus. */
export function suggestionKey(
  key: string,
  open: boolean,
  suggestions: readonly SlashSuggestion[],
  index: number,
): SuggestionAction {
  if (!open || suggestions.length === 0) return { type: "none" };
  if (key === "Escape") return { type: "close" };
  if (key === "ArrowDown") {
    return { type: "move", index: (index + 1) % suggestions.length };
  }
  if (key === "ArrowUp") {
    return {
      type: "move",
      index: (index - 1 + suggestions.length) % suggestions.length,
    };
  }
  if (key === "Enter") {
    const suggestion = suggestions[index] ?? suggestions[0];
    if (!suggestion) return { type: "none" };
    return { type: "accept", suggestion };
  }
  return { type: "none" };
}

function normalizeSlash(raw: string): string {
  const trailing = /\s$/.test(raw);
  const collapsed = raw.trim().replace(/\s+/g, " ");
  if (!collapsed.startsWith("/")) return collapsed;
  return trailing ? `${collapsed} ` : collapsed;
}

function commandSuggestions(
  lower: string,
  sections: readonly SlashSection[],
): readonly SlashSuggestion[] {
  return catalog(sections)
    .filter((row) => matchesCommand(row, lower))
    .slice(0, LIMIT);
}

function catalog(sections: readonly SlashSection[]): SlashSuggestion[] {
  const core = sections.filter(
    (section) => section.path === "/vault" || section.path === "/settings",
  );
  const rest = sections.filter(
    (section) => section.path !== "/vault" && section.path !== "/settings",
  );
  const lead = VERBS.filter((verb) => LEAD_VERBS.has(verb.id));
  const tail = VERBS.filter((verb) => !LEAD_VERBS.has(verb.id));
  return [...core.map(destination), ...lead, ...rest.map(destination), ...tail];
}

function destination(section: SlashSection): SlashSuggestion {
  const path = section.path.startsWith("/") ? section.path : `/${section.path}`;
  return { id: `go:${path}`, insert: path, label: section.label, run: true };
}

function matchesCommand(row: SlashSuggestion, lower: string): boolean {
  const insert = row.insert.trim().toLowerCase();
  const label = row.label.toLowerCase();
  const alias = ALIASES.get(row.id);
  return (
    insert.startsWith(lower) ||
    alias?.startsWith(lower) ||
    label.startsWith(lower.slice(1)) ||
    `/${label}`.startsWith(lower)
  );
}

function argumentSuggestions(
  text: string,
  itemNames: readonly string[],
): readonly SlashSuggestion[] | null {
  // Search has no list of names to pick from: the listing narrows as the
  // words are typed, and is the completion.
  if (liveSearchOf(text) !== null) return [];
  const opened = /^\/open\s+(.*)$/i.exec(text);
  if (opened) return itemRows("open", "/open ", opened[1] ?? "", itemNames);
  const copied = /^\/copy\s+(\S+)\s+(.*)$/i.exec(text);
  if (!copied) return null;
  const field = canonicalField(copied[1] ?? "");
  if (!field) return [];
  return itemRows(
    `copy-${field}`,
    `/copy ${field} `,
    copied[2] ?? "",
    itemNames,
  );
}

function canonicalField(word: string): CommandField | null {
  const lower = word.toLowerCase();
  return (
    FIELD_WORDS.find((entry) => entry.words.includes(lower))?.field ?? null
  );
}

function itemRows(
  kind: string,
  prefix: string,
  query: string,
  names: readonly string[],
): SlashSuggestion[] {
  const needle = query.trim().toLowerCase();
  return names
    .map((name) => name.trim())
    .filter((name) => name !== "" && scoreName(name, needle) > 0)
    .sort(
      (left, right) =>
        scoreName(right, needle) - scoreName(left, needle) ||
        left.localeCompare(right),
    )
    .slice(0, LIMIT)
    .map((name, index) => ({
      id: `${kind}:${index}:${name}`,
      insert: `${prefix}${name}`,
      label: name,
      run: true,
    }));
}

function scoreName(name: string, needle: string): number {
  if (needle === "") return 1;
  const folded = name.toLowerCase();
  if (folded === needle) return 100;
  if (folded.startsWith(needle)) return 80;
  if (folded.includes(needle)) return 60;
  return 0;
}
