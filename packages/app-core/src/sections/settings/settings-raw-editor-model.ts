import { isBoolean, isNumber, isString } from "@opensesame/os-domain";
import { loadKeybindings } from "../../lib/configuration/nav-persist.js";
/**
 * View-model logic for a settings directory's `config.yaml` (ADR 0133 §8):
 * the pure part of that screen — no React, no DOM — so any shell can drive
 * the same behaviour.
 */
import { type PagesSettings, loadSettings } from "../../lib/settings.js";
import type { VaultPrefs } from "../../lib/vault/store.js";
import type { SettingsDoc } from "./settings-files.js";

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
      keybindings: { ...loadKeybindings() },
    };
  }
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
        mfaAppUrl: pages.mfaAppUrl,
      },
      keybindings: {},
    };
  }
  return { values: {}, keybindings: {} };
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
    mfaAppUrl: text("mfaAppUrl", current.mfaAppUrl),
    activeProjectId: text("activeProjectId", current.activeProjectId ?? ""),
  };
}

export function applySuggestion(
  source: string,
  caret: number,
  suggestion: string,
): string {
  const start = source.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
  const endBreak = source.indexOf("\n", caret);
  const end = endBreak === -1 ? source.length : endBreak;
  const line = source.slice(start, end);
  const next = line.includes(":")
    ? `${line.slice(0, line.indexOf(":") + 1)} ${suggestion}`
    : `${line.match(/^\s*/)?.[0] ?? ""}${suggestion}: `;
  return `${source.slice(0, start)}${next}${source.slice(end)}`;
}

export function valueClass(value: string): string {
  const trimmed = value.replace(/\s#.*$/, "").trim();
  if (trimmed === "true" || trimmed === "false") return "set-raw__bool";
  if (/^-?\d+$/.test(trimmed)) return "set-raw__num";
  return "set-raw__str";
}
