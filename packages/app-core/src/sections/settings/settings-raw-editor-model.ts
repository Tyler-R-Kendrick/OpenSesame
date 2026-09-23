import { isString } from "@opensesame/os-domain";
import { loadKeybindings } from "../../lib/configuration/nav-persist.js";
/**
 * View-model logic for `SettingsRawEditor` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import type { SettingsCategory } from "../../lib/crumbs.js";
import { loadSettings } from "../../lib/settings.js";
import type { VaultPrefs } from "../../lib/vault/store.js";
import type { RawFormat, SettingsDoc } from "./settings-files.js";

export function readDoc(
  category: SettingsCategory,
  prefs: VaultPrefs,
): SettingsDoc {
  const pages = loadSettings();
  if (category === "general") {
    return {
      values: {
        theme: prefs.theme,
        clipboardClearSeconds: prefs.clipboardClearSeconds,
      },
      keybindings: { ...persistSafeBindings() },
    };
  }
  if (category === "security") {
    return {
      values: {
        autoLockMinutes: prefs.autoLockMinutes,
        lockOnHide: prefs.lockOnHide,
        signOutOnLock: prefs.signOutOnLock,
      },
      keybindings: {},
    };
  }
  if (category === "vaults") {
    return {
      values: { activeProjectId: pages.activeProjectId ?? "" },
      keybindings: {},
    };
  }
  if (category === "connections") {
    return {
      values: {
        hostApi: pages.hostApi,
        identityApi: pages.identityApi,
        daemonApi: pages.daemonApi,
        mfaAppUrl: pages.mfaAppUrl,
      },
      keybindings: {},
    };
  }
  return { values: {}, keybindings: {} };
}

export function persistSafeBindings() {
  return { ...loadKeybindings() };
}

export function mergePages(doc: SettingsDoc) {
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
    mfaAppUrl: text("mfaAppUrl", current.mfaAppUrl),
    activeProjectId: text("activeProjectId", current.activeProjectId ?? ""),
  };
}

export function applySuggestion(
  source: string,
  caret: number,
  suggestion: string,
  format: RawFormat,
): string {
  const start = source.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
  const endBreak = source.indexOf("\n", caret);
  const end = endBreak === -1 ? source.length : endBreak;
  const line = source.slice(start, end);
  const sep = format === "toml" ? "=" : ":";
  const hasSep = line.includes(sep);
  const next = hasSep
    ? `${line.slice(0, line.indexOf(sep) + 1)} ${suggestion}`
    : `${suggestion}${sep} `;
  return `${source.slice(0, start)}${next}${source.slice(end)}`;
}

export function valueClass(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "true" || trimmed === "false") return "set-raw__bool";
  if (/^-?\d+$/.test(trimmed)) return "set-raw__num";
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return "set-raw__str";
  return "set-raw__str";
}
