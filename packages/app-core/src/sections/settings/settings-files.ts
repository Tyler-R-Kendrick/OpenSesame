/**
 * One settings file per section. Form fields and this document are the same
 * values; YAML and TOML are two spellings of it.
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
import type { SettingsCategory } from "../../lib/crumbs.js";

export type RawFormat = "yaml" | "toml";

export type FieldKind = "string" | "number" | "boolean" | "enum" | "keymap";

export type SettingsField = {
  key: string;
  kind: FieldKind;
  options?: readonly string[];
};

export type SettingsDoc = {
  values: Record<string, string | number | boolean>;
  keybindings: Record<string, string>;
};

const THEMES = ["system", "light", "dark"] as const;
const BINDING_KEYS = Object.keys(DEFAULT_KEYBINDINGS);
const BINDING_ACTIONS = [...new Set(Object.values(DEFAULT_KEYBINDINGS))];

const GENERAL = [
  { key: "theme", kind: "enum", options: THEMES },
  { key: "clipboardClearSeconds", kind: "number" },
  { key: "keybindings", kind: "keymap" },
] as const satisfies readonly SettingsField[];

const SECURITY = [
  { key: "autoLockMinutes", kind: "number" },
  { key: "lockOnHide", kind: "boolean" },
  { key: "signOutOnLock", kind: "boolean" },
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

export function settingsFields(
  category: SettingsCategory,
): readonly SettingsField[] {
  if (category === "general") return GENERAL;
  if (category === "security") return SECURITY;
  if (category === "vaults") return VAULTS;
  // The endpoints file moved with the providers: Connections folded into
  // Capabilities (ADR 0135), and so did its settings file.
  if (category === "connections" || category === "capabilities")
    return CONNECTIVITY;
  return [];
}

export function settingsFilePath(
  category: SettingsCategory,
  format: RawFormat,
): string {
  // Same path as before the fold, so a file a person already saved is found.
  const file = category === "capabilities" ? "connections" : category;
  return `settings/${file}.${format}`;
}

export function emptyDoc(): SettingsDoc {
  return { values: {}, keybindings: {} };
}

export function encodeSettings(
  category: SettingsCategory,
  doc: SettingsDoc,
  format: RawFormat,
): string {
  const fields = settingsFields(category);
  if (format === "toml") return encodeToml(fields, doc);
  return encodeYaml(fields, doc);
}

export function decodeSettings(
  category: SettingsCategory,
  source: string,
  format: RawFormat,
): { ok: true; doc: SettingsDoc } | { ok: false; message: string } {
  const parsed = format === "toml" ? decodeToml(source) : decodeYaml(source);
  if (!parsed.ok) return parsed;
  return constrain(category, parsed.doc);
}

export function suggestSettings(
  category: SettingsCategory,
  source: string,
  caret: number,
): readonly string[] {
  const line = lineAt(source, caret);
  const trimmed = line.trim();
  const fields = settingsFields(category);
  const keyMatch = /^([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*)$/.exec(trimmed);
  const tomlMatch = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*)$/.exec(trimmed);
  const typedKey = keyMatch?.[1] ?? tomlMatch?.[1];
  const typedValue = (keyMatch?.[2] ?? tomlMatch?.[2] ?? "").replace(
    /^["']|["']$/g,
    "",
  );
  if (typedKey) {
    const field = fields.find((item) => item.key === typedKey);
    if (field?.kind === "enum" && field.options) {
      return field.options.filter((option) => option.startsWith(typedValue));
    }
    if (field?.kind === "boolean") {
      return ["true", "false"].filter((option) =>
        option.startsWith(typedValue),
      );
    }
    if (field?.kind === "keymap") return BINDING_ACTIONS;
    return [];
  }
  if (
    trimmed.startsWith("[") ||
    source.slice(0, caret).includes("[keybindings]")
  ) {
    return BINDING_KEYS;
  }
  return fields
    .map((field) => field.key)
    .filter((key) => key.startsWith(trimmed));
}

function encodeYaml(
  fields: readonly SettingsField[],
  doc: SettingsDoc,
): string {
  const lines: string[] = [];
  for (const field of fields) {
    if (field.kind === "keymap") continue;
    const value = doc.values[field.key];
    if (value === undefined) continue;
    lines.push(`${field.key}: ${yamlScalar(value)}`);
  }
  const bindings = Object.entries(doc.keybindings);
  if (fields.some((field) => field.kind === "keymap") && bindings.length > 0) {
    lines.push("keybindings:");
    for (const [key, action] of bindings) {
      lines.push(`  ${yamlKey(key)}: ${yamlScalar(action)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function encodeToml(
  fields: readonly SettingsField[],
  doc: SettingsDoc,
): string {
  const lines: string[] = [];
  for (const field of fields) {
    if (field.kind === "keymap") continue;
    const value = doc.values[field.key];
    if (value === undefined) continue;
    lines.push(`${field.key} = ${tomlScalar(value)}`);
  }
  const bindings = Object.entries(doc.keybindings);
  if (fields.some((field) => field.kind === "keymap") && bindings.length > 0) {
    lines.push("", "[keybindings]");
    for (const [key, action] of bindings) {
      lines.push(`${tomlScalar(key)} = ${tomlScalar(action)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function decodeYaml(
  source: string,
): { ok: true; doc: SettingsDoc } | { ok: false; message: string } {
  const parsed = parseConfigYaml(source);
  if (!parsed.ok) {
    return {
      ok: false,
      message: parsed.diagnostics[0]?.message ?? "Invalid YAML.",
    };
  }
  return { ok: true, doc: docFromObject(parsed.value) };
}

function decodeToml(
  source: string,
): { ok: true; doc: SettingsDoc } | { ok: false; message: string } {
  const doc = emptyDoc();
  let section = "";
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).trim();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) return { ok: false, message: "Invalid TOML." };
    const key = unquote(line.slice(0, eq).trim());
    const value = unquote(line.slice(eq + 1).trim());
    if (section === "keybindings") {
      doc.keybindings[key] = value;
      continue;
    }
    if (section !== "") return { ok: false, message: "Unknown table." };
    doc.values[key] = coerceScalar(value);
  }
  return { ok: true, doc };
}

function constrain(
  category: SettingsCategory,
  doc: SettingsDoc,
): { ok: true; doc: SettingsDoc } | { ok: false; message: string } {
  const allowed = new Set(settingsFields(category).map((field) => field.key));
  for (const key of Object.keys(doc.values)) {
    if (!allowed.has(key))
      return { ok: false, message: `${key} is not a setting.` };
    const field = settingsFields(category).find((item) => item.key === key);
    if (!field) continue;
    const value = doc.values[key];
    if (
      field.kind === "enum" &&
      field.options &&
      !field.options.includes(String(value))
    ) {
      return {
        ok: false,
        message: `${key} must be ${field.options.join(", ")}.`,
      };
    }
    if (field.kind === "boolean" && !isBoolean(value)) {
      return { ok: false, message: `${key} must be true or false.` };
    }
    if (field.kind === "number" && !isNumber(value)) {
      return { ok: false, message: `${key} must be a number.` };
    }
  }
  if (!allowed.has("keybindings") && Object.keys(doc.keybindings).length > 0) {
    return { ok: false, message: "keybindings is not a setting here." };
  }
  return { ok: true, doc };
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
    if (isString(raw) || isNumber(raw) || isBoolean(raw)) doc.values[key] = raw;
  }
  return doc;
}

function coerceScalar(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function yamlScalar(value: string | number | boolean): string {
  if (isString(value)) return JSON.stringify(value);
  return String(value);
}

function yamlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

function tomlScalar(value: string | number | boolean): string {
  if (isString(value)) return JSON.stringify(value);
  return String(value);
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function lineAt(source: string, caret: number): string {
  const start = source.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
  const end = source.indexOf("\n", caret);
  return source.slice(start, end === -1 ? source.length : end);
}
