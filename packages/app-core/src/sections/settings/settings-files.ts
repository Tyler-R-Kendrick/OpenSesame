/**
 * One `config.yaml` per settings directory. Each file is the page it sits
 * beside, spelled as YAML: the form and the file are the same values, so a
 * change in either is a change in both (`settings-config.ts` keeps the
 * person's comments across that round trip).
 */
import {
  type BoundaryValue,
  type JsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { parseConfigYaml } from "../../lib/configuration/yaml-profile.js";
import { SETTINGS_CONFIG_FILE } from "../../lib/crumbs.js";
import {
  CONTEXTS_REFUSAL,
  type ContextsDoc,
  type MacroDoc,
  bindingsFromObject,
  contextsFromObject,
  contextsReadable,
  keymapLines,
  macrosFromObject,
  rawKeymapRefusal,
  readKeymapParts,
  stableContexts,
  stableMacros,
  yamlKey,
} from "./settings-keymap-yaml.js";
import {
  bindingSuggestions,
  gestureSuggestions,
  inBindings,
  inGestures,
  indentOf,
  lineAt,
} from "./settings-suggest.js";

export type { ContextsDoc, MacroDoc } from "./settings-keymap-yaml.js";

export {
  SETTINGS_CONFIG_FILE,
  isSettingsConfigSearch,
  settingsConfigRoute,
  settingsFileFromSearch,
  settingsFileRoute,
} from "../../lib/crumbs.js";

export type FieldKind =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "keymap"
  | "macros"
  | "contexts"
  | "gestures"
  | "list";

export type SettingsField = {
  key: string;
  kind: FieldKind;
  options?: readonly string[];
  /**
   * State the page shows but a ceremony owns (an unlock method, an approved
   * capability). The file reports it; writing a different value is refused,
   * never quietly ignored.
   */
  readonly?: boolean;
};

export type SettingsValue = string | number | boolean | string[];

export type SettingsDoc = {
  values: Record<string, SettingsValue>;
  keybindings: Record<string, string>;
  /** Settings › Keybindings only (ADR 0156). */
  macros?: Record<string, MacroDoc>;
  /** Keys that hold in one listing only: `vault:` or `rail:` (ADR 0156 §6). */
  contexts?: ContextsDoc;
  /** The touch loadout: gesture → action (ADR 0164). */
  gestures?: Record<string, string>;
};

export type DecodeResult =
  | { ok: true; doc: SettingsDoc }
  | { ok: false; message: string };

const THEMES = ["system", "light", "dark"] as const;
/** Settings › General draws Appearance and Locking. */
const GENERAL = [
  { key: "theme", kind: "enum", options: THEMES },
  { key: "autoLockMinutes", kind: "number" },
  { key: "clipboardClearSeconds", kind: "number" },
  { key: "lockOnHide", kind: "boolean" },
  { key: "signOutOnLock", kind: "boolean" },
] as const satisfies readonly SettingsField[];

/**
 * Settings › Keybindings (ADR 0156): only what the person changed — the
 * character-key switch, the bindings laid over the defaults, the keys that
 * hold in one listing, their macros.
 */
const KEYBINDINGS = [
  { key: "singleKeys", kind: "boolean" },
  { key: "motion", kind: "boolean" },
  { key: "keybindings", kind: "keymap" },
  { key: "gestures", kind: "gestures" },
  { key: "contexts", kind: "contexts" },
  { key: "macros", kind: "macros" },
] as const satisfies readonly SettingsField[];

/** Kinds a keymap reads, never a plain value. */
const KEYMAP_KINDS: ReadonlySet<FieldKind> = new Set([
  "keymap",
  "macros",
  "contexts",
  "gestures",
]);

/** Settings › Security: every row there changes through its own sheet. */
const SECURITY = [
  { key: "unlockMethods", kind: "list", readonly: true },
  { key: "secondSteps", kind: "list", readonly: true },
] as const satisfies readonly SettingsField[];

const VAULTS = [
  { key: "activeProjectId", kind: "string" },
] as const satisfies readonly SettingsField[];

const CONNECTIVITY = [
  { key: "hostApi", kind: "string" },
  { key: "identityApi", kind: "string" },
  { key: "daemonApi", kind: "string" },
] as const satisfies readonly SettingsField[];

/**
 * Settings › Capabilities: the endpoints its providers are configured with
 * (Connections folded in, ADR 0135), and what the plan approved — adding or
 * retiring one is a reviewed plan with a consent receipt.
 */
const CAPABILITIES = [
  { key: "approved", kind: "list", readonly: true },
  ...CONNECTIVITY,
] as const satisfies readonly SettingsField[];

const FIELDS = new Map<string, readonly SettingsField[]>([
  ["general", GENERAL],
  ["keybindings", KEYBINDINGS],
  ["security", SECURITY],
  ["vaults", VAULTS],
  // An older link to Connections reads as Capabilities.
  ["connections", CAPABILITIES],
  ["capabilities", CAPABILITIES],
]);

export function settingsFields(category: string): readonly SettingsField[] {
  return FIELDS.get(category) ?? [];
}

/**
 * Where a directory's text was kept before each directory had a
 * `config.yaml` (`settings/general.yaml`). Read once as the starting point,
 * so a person's comments survive the move; never written again.
 */
export function legacySettingsFilePath(category: string): string {
  // The endpoints were kept as Connections' file before the fold.
  const file = category === "capabilities" ? "connections" : category;
  return `settings/${file}.yaml`;
}

/** `settings/general/config.yaml` — the file's name in the rail and editor. */
export function settingsFilePath(category: string): string {
  return `settings/${category}/${SETTINGS_CONFIG_FILE}`;
}

export function emptyDoc(): SettingsDoc {
  return { values: {}, keybindings: {} };
}

export function encodeSettings(category: string, doc: SettingsDoc): string {
  const fields = settingsFields(category);
  if (fields.length === 0) return "# Nothing on this page is a setting.\n";
  const lines: string[] = [];
  for (const field of fields) {
    if (KEYMAP_KINDS.has(field.kind)) continue;
    const value = doc.values[field.key];
    if (value === undefined) continue;
    const note = field.readonly ? " # read-only: changed on its page" : "";
    lines.push(`${field.key}: ${yamlValue(value)}${note}`);
  }
  lines.push(
    ...keymapLines(doc, (kind) => fields.some((field) => field.kind === kind)),
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Parse a `config.yaml` against its directory. With `current`, a read-only
 * key may only restate what the page already shows.
 */
export function decodeSettings(
  category: string,
  source: string,
  current?: SettingsDoc,
): DecodeResult {
  const parsed = parseConfigYaml(source);
  if (!parsed.ok) {
    return {
      ok: false,
      message: parsed.diagnostics[0]?.message ?? "Invalid YAML.",
    };
  }
  if (!contextsReadable(parsed.value.contexts))
    return { ok: false, message: CONTEXTS_REFUSAL };
  if (settingsFields(category).some((field) => field.kind === "keymap")) {
    const refusal = rawKeymapRefusal(parsed.value);
    if (refusal) return refusal;
  }
  return constrain(category, docFromObject(parsed.value), current);
}

/**
 * What may be typed at the caret, narrowed to what has been typed. A top-level
 * line offers a directory's writable keys and their values; a line inside the
 * `keybindings:` mapping (or a `contexts.<listing>` one) offers keys, then
 * action ids. Any other indented line — a macro's steps, a trigger — offers
 * nothing, so nothing there is ever rewritten.
 */
export function suggestSettings(
  category: string,
  source: string,
  caret: number,
): readonly string[] {
  const { text } = lineAt(source, caret);
  const fields = settingsFields(category).filter((field) => !field.readonly);
  if (indentOf(text) > 0) {
    const gestures = fields.some((field) => field.kind === "gestures");
    if (gestures && inGestures(source, caret))
      return gestureSuggestions(source, caret);
    const keymap = fields.some((field) => field.kind === "keymap");
    return keymap && inBindings(source, caret)
      ? bindingSuggestions(source, caret)
      : [];
  }
  return topLevelSuggestions(fields, text.trim());
}

function topLevelSuggestions(
  fields: readonly SettingsField[],
  trimmed: string,
): readonly string[] {
  const keyMatch = /^([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*)$/.exec(trimmed);
  const typedKey = keyMatch?.[1];
  const typedValue = (keyMatch?.[2] ?? "").replace(/^["']|["']$/g, "");
  if (!typedKey) {
    return fields
      .map((field) => field.key)
      .filter((key) => key.startsWith(trimmed));
  }
  const field = fields.find((item) => item.key === typedKey);
  const options =
    field?.kind === "enum"
      ? (field.options ?? [])
      : field?.kind === "boolean"
        ? ["true", "false"]
        : [];
  // A finished value is not offered back. The key itself still is, so Tab
  // can write the colon after it.
  return options.filter(
    (option) => option !== typedValue && option.startsWith(typedValue),
  );
}

/** Same values, same bindings — spelling and comments aside. */
export function sameDoc(left: SettingsDoc, right: SettingsDoc): boolean {
  return (
    stable(left.values) === stable(right.values) &&
    stable(left.keybindings) === stable(right.keybindings) &&
    stable(left.gestures ?? {}) === stable(right.gestures ?? {}) &&
    stableMacros(left.macros) === stableMacros(right.macros) &&
    stableContexts(left.contexts) === stableContexts(right.contexts)
  );
}

function stable(record: Readonly<Record<string, SettingsValue>>): string {
  return JSON.stringify(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]]),
  );
}

function sameValue(left: SettingsValue, right: SettingsValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function constrain(
  category: string,
  doc: SettingsDoc,
  current: SettingsDoc | undefined,
): DecodeResult {
  const fields = settingsFields(category);
  for (const [key, value] of Object.entries(doc.values)) {
    const field = fields.find((item) => item.key === key);
    if (!field || KEYMAP_KINDS.has(field.kind)) {
      return { ok: false, message: `${key} is not a setting here.` };
    }
    const problem = checkValue(field, value, current?.values[key]);
    if (problem) return { ok: false, message: problem };
  }
  return keymapProblem(fields, doc) ?? { ok: true, doc };
}

/** The keymap's own rules, or its absence where a directory has none. */
function keymapProblem(
  fields: readonly SettingsField[],
  doc: SettingsDoc,
): DecodeResult | null {
  const has = (kind: FieldKind) => fields.some((field) => field.kind === kind);
  const written: readonly (readonly [FieldKind, string, number])[] = [
    ["keymap", "keybindings", Object.keys(doc.keybindings).length],
    ["macros", "macros", Object.keys(doc.macros ?? {}).length],
    ["contexts", "contexts", Object.keys(doc.contexts ?? {}).length],
    ["gestures", "gestures", Object.keys(doc.gestures ?? {}).length],
  ];
  const stray = written.find(([kind, , count]) => !has(kind) && count > 0);
  if (stray)
    return { ok: false, message: `${stray[1]} is not a setting here.` };
  if (!has("keymap")) return null;
  const keymap = readKeymapParts(
    doc,
    doc.values.singleKeys ?? true,
    doc.values.motion ?? true,
  );
  return keymap.ok ? null : keymap;
}

function checkValue(
  field: SettingsField,
  value: SettingsValue,
  current: SettingsValue | undefined,
): string | null {
  const { key } = field;
  if (field.readonly) {
    if (current !== undefined && !sameValue(current, value))
      return `${key} is read-only here; change it on its page.`;
    return null;
  }
  if (field.kind === "enum" && !field.options?.includes(String(value))) {
    return `${key} must be ${field.options?.join(", ")}.`;
  }
  if (field.kind === "boolean" && !isBoolean(value)) {
    return `${key} must be true or false.`;
  }
  if (field.kind === "number" && !isNumber(value)) {
    return `${key} must be a number.`;
  }
  if (field.kind === "string" && !isString(value)) {
    return `${key} must be text.`;
  }
  return null;
}

/** A keymap's own keys, set on `doc`; false for every other key. */
function takeKeymapKey(doc: SettingsDoc, key: string, raw: BoundaryValue) {
  if (key === "keybindings" && isJsonObject(raw))
    doc.keybindings = bindingsFromObject(raw);
  else if (key === "contexts") doc.contexts = contextsFromObject(raw);
  else if (key === "gestures" && isJsonObject(raw))
    doc.gestures = bindingsFromObject(raw);
  else if (key === "macros" && isJsonObject(raw))
    doc.macros = macrosFromObject(raw);
  else return false;
  return true;
}

function docFromObject(value: JsonObject): SettingsDoc {
  const doc = emptyDoc();
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || takeKeymapKey(doc, key, raw)) continue;
    if (Array.isArray(raw)) {
      doc.values[key] = raw.map(String);
      continue;
    }
    if (isString(raw) || isNumber(raw) || isBoolean(raw)) doc.values[key] = raw;
  }
  return doc;
}

function yamlValue(value: SettingsValue): string {
  if (isString(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(yamlKey).join(", ")}]`;
  return String(value);
}
