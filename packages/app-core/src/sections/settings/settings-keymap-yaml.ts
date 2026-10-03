/**
 * The Keybindings `config.yaml`'s own keys (ADR 0155): `keybindings:`,
 * `contexts:` and `macros:`, spelled and read here so `settings-files.ts`
 * stays the directory-agnostic codec.
 */
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { NOP, keymapCommands } from "../../lib/keymap/commands.js";
import { type KeymapResult, readKeymap } from "../../lib/keymap/config.js";
import { defaultBindings } from "../../lib/keymap/effective.js";

/** A macro as the file spells it: its trigger and its written steps. */
export type MacroDoc = { on?: string; steps: string[] };

/** `vault:` / `rail:` → that listing's keys, as the file spells them. */
export type BindingsDoc = Record<string, string>;

export type ContextsDoc = Record<string, BindingsDoc>;

export type KeymapParts = Readonly<{
  keybindings: Readonly<Record<string, string>>;
  contexts?: Readonly<ContextsDoc>;
  macros?: Readonly<Record<string, MacroDoc>>;
}>;

export const CONTEXTS_REFUSAL =
  "contexts is a mapping of vault and rail to keybindings.";

/** A command id reads bare: `listing.next`, not `"listing.next"`. */
export function yamlWord(value: string): string {
  return /^[A-Za-z][A-Za-z0-9_.-]*$/.test(value)
    ? value
    : JSON.stringify(value);
}

/** Words YAML reads as something other than text (1.2's, and 1.1's too). */
const YAML_WORDS = /^(true|false|null|yes|no|on|off)$/i;

/**
 * A key or word written bare only when it reads back as the same text: a
 * bare `0` is the number 0 and a bare `on` a boolean, so those are quoted.
 */
export function yamlKey(value: string): string {
  const bare =
    /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) && !YAML_WORDS.test(value);
  return bare ? value : JSON.stringify(value);
}

function bindingLines(
  name: string,
  bindings: Readonly<Record<string, string>>,
  indent = "",
): string[] {
  const entries = Object.entries(bindings);
  if (entries.length === 0) return [];
  return [
    `${indent}${name}:`,
    ...entries.map(
      ([key, action]) => `${indent}  ${yamlKey(key)}: ${yamlWord(action)}`,
    ),
  ];
}

function contextLines(contexts: Readonly<ContextsDoc>): string[] {
  const lines = Object.entries(contexts).flatMap(([name, layer]) =>
    bindingLines(yamlKey(name), layer, "  "),
  );
  return lines.length > 0 ? ["contexts:", ...lines] : [];
}

function macroLines(macros: Readonly<Record<string, MacroDoc>>): string[] {
  const entries = Object.entries(macros);
  if (entries.length === 0) return [];
  const lines = ["macros:"];
  for (const [name, macro] of entries) {
    lines.push(`  ${yamlKey(name)}:`);
    if (macro.on) lines.push(`    on: ${yamlKey(macro.on)}`);
    lines.push(`    steps: [${macro.steps.map(yamlWord).join(", ")}]`);
  }
  return lines;
}

/** The keymap's lines, for the keys this directory has. */
export function keymapLines(
  parts: KeymapParts,
  has: (key: "keymap" | "contexts" | "macros") => boolean,
): string[] {
  return [
    ...(has("keymap") ? bindingLines("keybindings", parts.keybindings) : []),
    ...(has("contexts") ? contextLines(parts.contexts ?? {}) : []),
    ...(has("macros") ? macroLines(parts.macros ?? {}) : []),
  ];
}

export function bindingsFromObject(raw: JsonObject) {
  const bindings: BindingsDoc = {};
  for (const [binding, action] of Object.entries(raw)) {
    // `x: null` (or `~`) strikes a default, as `x: nop` does.
    if (isString(action)) bindings[binding] = action;
    else if (action === null) bindings[binding] = NOP;
  }
  return bindings;
}

/** `contexts:` is absent, empty, or a mapping of mappings (or of nothing). */
export function contextsReadable(raw: BoundaryValue | undefined): boolean {
  if (raw === undefined || raw === null) return true;
  if (!isJsonObject(raw)) return false;
  return Object.values(raw).every(
    (layer) => layer === null || isJsonObject(layer),
  );
}

export function contextsFromObject(raw: BoundaryValue | undefined) {
  const contexts: ContextsDoc = {};
  if (!isJsonObject(raw)) return contexts;
  for (const [name, layer] of Object.entries(raw)) {
    contexts[name] = isJsonObject(layer) ? bindingsFromObject(layer) : {};
  }
  return contexts;
}

export function macrosFromObject(raw: JsonObject) {
  const macros: Record<string, MacroDoc> = {};
  for (const [name, body] of Object.entries(raw)) {
    const steps = Array.isArray(body)
      ? body
      : isJsonObject(body) && Array.isArray(body.steps)
        ? body.steps
        : [];
    const doc: MacroDoc = { steps: steps.map(String) };
    if (isJsonObject(body) && isString(body.on)) doc.on = body.on;
    macros[name] = doc;
  }
  return macros;
}

function stable(record: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]]),
  );
}

/** Contexts compared by what they bind: order and empty layers aside. */
export function stableContexts(contexts: Readonly<ContextsDoc> = {}): string {
  return JSON.stringify(
    Object.entries(contexts)
      .filter(([, layer]) => Object.keys(layer).length > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, layer]) => [name, stable(layer)]),
  );
}

/**
 * The file's keymap keys read exactly as written, before they are shaped
 * into the doc. The doc drops what it cannot spell (`w: 5`, `on: [unlock]`),
 * and a save from it would then quietly delete the person's line; read raw,
 * the keymap refuses it with its own message instead. Null when it passes.
 */
export function rawKeymapRefusal(
  raw: JsonObject,
): { ok: false; message: string } | null {
  const commands = keymapCommands();
  const read = readKeymap(
    {
      bindings: raw.keybindings ?? {},
      macros: raw.macros ?? {},
      contexts: raw.contexts ?? {},
    },
    commands,
    defaultBindings(commands),
  );
  return read.ok ? null : read;
}

/** The keymap's own rules, read over the file's parts. */
export function readKeymapParts(
  parts: KeymapParts,
  singleKeys: BoundaryValue,
): KeymapResult {
  const commands = keymapCommands();
  return readKeymap(
    {
      bindings: parts.keybindings,
      macros: parts.macros ?? {},
      singleKeys,
      contexts: parts.contexts ?? {},
    },
    commands,
    defaultBindings(commands),
  );
}

/** One macro compared by what it does: its trigger and its steps. */
export function stableMacro(macro: MacroDoc | undefined): string {
  return JSON.stringify([macro?.on ?? null, macro?.steps ?? null]);
}

/** Macros compared by what they do: order and field order aside. */
export function stableMacros(
  macros: Readonly<Record<string, MacroDoc>> = {},
): string {
  return JSON.stringify(
    Object.keys(macros)
      .sort()
      .map((name) => [name, stableMacro(macros[name])]),
  );
}
