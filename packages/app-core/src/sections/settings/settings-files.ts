/**
 * One `config.yaml` per settings directory. Each file is the page it sits
 * beside, spelled as YAML: the form and the file are the same values, so a
 * change in either is a change in both (`settings-config.ts` keeps the
 * person's comments across that round trip).
 */
import {
  type JsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { DEFAULT_KEYBINDINGS } from "../../lib/configuration/keybindings.js";
import { parseConfigYaml } from "../../lib/configuration/yaml-profile.js";
import { SETTINGS_CONFIG_FILE } from "../../lib/crumbs.js";

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
};

export type DecodeResult =
  | { ok: true; doc: SettingsDoc }
  | { ok: false; message: string };

const THEMES = ["system", "light", "dark"] as const;
const BINDING_KEYS = Object.keys(DEFAULT_KEYBINDINGS);
const BINDING_ACTIONS = [...new Set(Object.values(DEFAULT_KEYBINDINGS))];

/** Settings › General draws Appearance, Locking and the keymap. */
const GENERAL = [
  { key: "theme", kind: "enum", options: THEMES },
  { key: "autoLockMinutes", kind: "number" },
  { key: "clipboardClearSeconds", kind: "number" },
  { key: "lockOnHide", kind: "boolean" },
  { key: "signOutOnLock", kind: "boolean" },
  { key: "keybindings", kind: "keymap" },
] as const satisfies readonly SettingsField[];

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
  { key: "mfaAppUrl", kind: "string" },
] as const satisfies readonly SettingsField[];

/** Adding or retiring one is a reviewed plan with a consent receipt. */
const CAPABILITIES = [
  { key: "approved", kind: "list", readonly: true },
] as const satisfies readonly SettingsField[];

const FIELDS = new Map<string, readonly SettingsField[]>([
  ["general", GENERAL],
  ["security", SECURITY],
  ["vaults", VAULTS],
  ["connections", CONNECTIVITY],
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
  return `settings/${category}.yaml`;
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
    if (field.kind === "keymap") continue;
    const value = doc.values[field.key];
    if (value === undefined) continue;
    const note = field.readonly ? " # read-only: changed on its page" : "";
    lines.push(`${field.key}: ${yamlValue(value)}${note}`);
  }
  const bindings = Object.entries(doc.keybindings);
  if (fields.some((field) => field.kind === "keymap") && bindings.length > 0) {
    lines.push("keybindings:");
    for (const [key, action] of bindings) {
      lines.push(`  ${yamlKey(key)}: ${yamlValue(action)}`);
    }
  }
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
  return constrain(category, docFromObject(parsed.value), current);
}

export function suggestSettings(
  category: string,
  source: string,
  caret: number,
): readonly string[] {
  const line = lineAt(source, caret);
  const trimmed = line.trim();
  const fields = settingsFields(category).filter((field) => !field.readonly);
  const keyMatch = /^([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*)$/.exec(trimmed);
  const typedKey = keyMatch?.[1];
  const typedValue = (keyMatch?.[2] ?? "").replace(/^["']|["']$/g, "");
  if (typedKey && !line.startsWith(" ")) {
    const field = fields.find((item) => item.key === typedKey);
    if (field?.kind === "enum" && field.options) {
      return field.options.filter((option) => option.startsWith(typedValue));
    }
    if (field?.kind === "boolean") {
      return ["true", "false"].filter((option) =>
        option.startsWith(typedValue),
      );
    }
    return [];
  }
  if (line.startsWith(" ") && source.slice(0, caret).includes("keybindings:")) {
    return typedKey ? BINDING_ACTIONS : BINDING_KEYS;
  }
  return fields
    .map((field) => field.key)
    .filter((key) => key.startsWith(trimmed));
}

/** Same values, same bindings — spelling and comments aside. */
export function sameDoc(left: SettingsDoc, right: SettingsDoc): boolean {
  return (
    stable(left.values) === stable(right.values) &&
    stable(left.keybindings) === stable(right.keybindings)
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
    if (!field || field.kind === "keymap") {
      return { ok: false, message: `${key} is not a setting here.` };
    }
    const problem = checkValue(field, value, current?.values[key]);
    if (problem) return { ok: false, message: problem };
  }
  if (
    !fields.some((field) => field.kind === "keymap") &&
    Object.keys(doc.keybindings).length > 0
  ) {
    return { ok: false, message: "keybindings is not a setting here." };
  }
  return { ok: true, doc };
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

function docFromObject(value: JsonObject): SettingsDoc {
  const doc = emptyDoc();
  for (const [key, raw] of Object.entries(value)) {
    if (key === "keybindings" && isJsonObject(raw)) {
      for (const [binding, action] of Object.entries(raw)) {
        if (isString(action)) doc.keybindings[binding] = action;
      }
      continue;
    }
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

function yamlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

function lineAt(source: string, caret: number): string {
  const start = source.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
  const end = source.indexOf("\n", caret);
  return source.slice(start, end === -1 ? source.length : end);
}
