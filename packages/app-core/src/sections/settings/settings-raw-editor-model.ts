import { isBoolean, isNumber, isString } from "@opensesame/os-domain";
import { NOP } from "../../lib/keymap/commands.js";
import { type KeymapConfig, formatStep } from "../../lib/keymap/config.js";
import { loadKeymap } from "../../lib/keymap/store.js";
/**
 * View-model logic for a settings directory's `config.yaml` (ADR 0133 §8):
 * the pure part of that screen — no React, no DOM — so any shell can drive
 * the same behaviour.
 */
import { type PagesSettings, loadSettings } from "../../lib/settings.js";
import type { VaultPrefs } from "../../lib/vault/store.js";
import type { ContextsDoc, MacroDoc, SettingsDoc } from "./settings-files.js";
import {
  indentOf,
  lineAt,
  separatorAt,
  typingAt,
  unquote,
} from "./settings-suggest.js";

/** Everything the settings pages show that a `config.yaml` reports. */
export type SettingsState = {
  prefs: VaultPrefs;
  unlockMethods: readonly string[];
  secondSteps: readonly string[];
  approvedCapabilities: readonly string[];
};

export function readDoc(category: string, state: SettingsState): SettingsDoc {
  const { prefs } = state;
  if (category === "general") {
    return {
      values: {
        theme: prefs.theme,
        autoLockMinutes: prefs.autoLockMinutes,
        clipboardClearSeconds: prefs.clipboardClearSeconds,
        lockOnHide: prefs.lockOnHide,
        signOutOnLock: prefs.signOutOnLock,
      },
      keybindings: {},
    };
  }
  if (category === "keybindings") return keymapDoc(loadKeymap());
  if (category === "security") {
    return {
      values: {
        unlockMethods: [...state.unlockMethods],
        secondSteps: [...state.secondSteps],
      },
      keybindings: {},
    };
  }
  const pages = loadSettings();
  if (category === "vaults") {
    return {
      values: { activeProjectId: pages.activeProjectId ?? "" },
      keybindings: {},
    };
  }
  // Connections folded into Capabilities (ADR 0135); its old link still
  // opens the same file.
  if (category === "capabilities" || category === "connections") {
    return {
      values: {
        approved: [...state.approvedCapabilities],
        hostApi: pages.hostApi,
        identityApi: pages.identityApi,
        daemonApi: pages.daemonApi,
      },
      keybindings: {},
    };
  }
  return { values: {}, keybindings: {} };
}

/** The keymap as its `config.yaml` spells it: only what the person changed. */
export function keymapDoc(config: KeymapConfig): SettingsDoc {
  const macros: Record<string, MacroDoc> = {};
  for (const [name, macro] of Object.entries(config.macros)) {
    const doc: MacroDoc = { steps: macro.steps.map(formatStep) };
    if (macro.on) doc.on = macro.on;
    macros[name] = doc;
  }
  const contexts: ContextsDoc = {};
  for (const [name, layer] of Object.entries(config.contexts ?? {})) {
    if (Object.keys(layer).length > 0) contexts[name] = { ...layer };
  }
  return {
    values: { singleKeys: config.singleKeys },
    keybindings: { ...config.bindings },
    contexts,
    macros,
  };
}

/** `nop` as the file's `null`, which reads back the same. */
function bindingData(layer: Readonly<Record<string, string>>) {
  const bindings: Record<string, string | null> = {};
  for (const [sequence, target] of Object.entries(layer))
    bindings[sequence] = target === NOP ? null : target;
  return bindings;
}

/** A Keybindings `config.yaml` as keymap data, for `saveKeymapData`. */
export function keymapData(doc: SettingsDoc) {
  const contexts: Record<string, Record<string, string | null>> = {};
  for (const [name, layer] of Object.entries(doc.contexts ?? {}))
    contexts[name] = bindingData(layer);
  return {
    bindings: bindingData(doc.keybindings),
    macros: doc.macros ?? {},
    singleKeys: doc.values.singleKeys ?? true,
    contexts,
  };
}

/** The vault prefs a General `config.yaml` sets; untouched keys stay. */
export function mergePrefs(prefs: VaultPrefs, doc: SettingsDoc): VaultPrefs {
  const next = { ...prefs };
  const theme = doc.values.theme;
  if (theme === "system" || theme === "light" || theme === "dark")
    next.theme = theme;
  const minutes = doc.values.autoLockMinutes;
  if (isNumber(minutes)) next.autoLockMinutes = minutes;
  const hide = doc.values.lockOnHide;
  if (isBoolean(hide)) next.lockOnHide = hide;
  const signOut = doc.values.signOutOnLock;
  if (isBoolean(signOut)) next.signOutOnLock = signOut;
  const clipboard = doc.values.clipboardClearSeconds;
  if (isNumber(clipboard)) next.clipboardClearSeconds = clipboard;
  return next;
}

export function mergePages(doc: SettingsDoc): PagesSettings {
  const current = loadSettings();
  const text = (key: string, fallback: string) => {
    const value = doc.values[key];
    return isString(value) ? value : fallback;
  };
  return {
    ...current,
    hostApi: text("hostApi", current.hostApi),
    identityApi: text("identityApi", current.identityApi),
    daemonApi: text("daemonApi", current.daemonApi),
    activeProjectId: text("activeProjectId", current.activeProjectId ?? ""),
  };
}

/** How many completions the list shows, once it has been narrowed. */
export const MAX_SUGGESTIONS = 12;

/** The file after a completion, and where the caret belongs in it. */
export type Completion = Readonly<{ source: string; caret: number }>;

/**
 * `suggestion` written where the caret is: over the value when the caret is
 * after the colon, over the key (keeping its value) when it is before it.
 */
export function completeAt(
  source: string,
  caret: number,
  suggestion: string,
): Completion {
  const { text, start, end } = lineAt(source, caret);
  const colon = separatorAt(text);
  const indent = text.slice(0, indentOf(text));
  const inValue = colon !== -1 && caret - start > colon;
  // Over the value, everything through the colon stays. Over the key, the
  // value stays after it (or a fresh `: ` is opened).
  const next = inValue
    ? `${text.slice(0, colon + 1)} ${suggestion}`
    : `${indent}${suggestion}${colon === -1 ? ": " : text.slice(colon)}`;
  const keyEnd = indent.length + suggestion.length + 2;
  const placed = inValue || colon === -1 ? next.length : keyEnd;
  return {
    source: `${source.slice(0, start)}${next}${source.slice(end)}`,
    caret: start + Math.min(placed, next.length),
  };
}

export function applySuggestion(
  source: string,
  caret: number,
  suggestion: string,
): string {
  return completeAt(source, caret, suggestion).source;
}

/** The plain text a suggestion stands for: `"g g"` is `g g`. */
function plain(suggestion: string): string {
  return unquote(suggestion);
}

/**
 * The completion Tab applies, or null — and then Tab moves focus, as it
 * always does. It applies only when the caret is at the end of a line, at the
 * end of a non-empty key or value a suggestion finishes. A key that is already
 * the suggestion still takes Tab, so the colon is written. A finished value,
 * an empty line, or a caret mid-line does not.
 */
export function tabSuggestion(
  source: string,
  caret: number,
  suggestions: readonly string[],
): string | null {
  const line = lineAt(source, caret);
  if (caret !== line.end) return null;
  const { typed } = typingAt(source, caret);
  if (typed.trim() === "") return null;
  const openKey = separatorAt(line.text) === -1;
  const matches = suggestions.filter((suggestion) =>
    plain(suggestion).startsWith(typed),
  );
  if (openKey) {
    return (
      matches.find((suggestion) => plain(suggestion) === typed) ??
      matches[0] ??
      null
    );
  }
  return matches.find((suggestion) => plain(suggestion) !== typed) ?? null;
}

export function valueClass(value: string): string {
  const trimmed = value.replace(/\s#.*$/, "").trim();
  if (trimmed === "true" || trimmed === "false") return "set-raw__bool";
  if (/^-?\d+$/.test(trimmed)) return "set-raw__num";
  return "set-raw__str";
}
