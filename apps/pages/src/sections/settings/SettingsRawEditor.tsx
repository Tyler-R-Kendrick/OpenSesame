import {
  isBoolean,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { useEffect, useState } from "react";
import { IconCheck } from "../../components/Icons.js";
import {
  loadKeybindings,
  persistKeybindings,
} from "../../lib/configuration/nav-persist.js";
import type { SettingsCategory } from "../../lib/crumbs.js";
import { loadSettings, saveSettings } from "../../lib/settings.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import type { VaultPrefs } from "../../lib/vault/store.js";
import {
  type RawFormat,
  type SettingsDoc,
  decodeSettings,
  encodeSettings,
  settingsFields,
  settingsFilePath,
  suggestSettings,
} from "./settings-files.js";

export function SettingsRawEditor({
  category,
  format,
}: {
  category: SettingsCategory;
  format: RawFormat;
}) {
  const store = useVaultStore();
  const { prefs } = useVault();
  const [source, setSource] = useState("");
  const [caret, setCaret] = useState(0);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setSource(encodeSettings(category, readDoc(category, prefs), format));
    setMessage("");
  }, [category, format, prefs]);

  const suggestions = suggestSettings(category, source, caret).slice(0, 8);
  const parsed = decodeSettings(category, source, format);

  function insert(suggestion: string) {
    setSource(applySuggestion(source, caret, suggestion, format));
  }

  async function save() {
    const decoded = decodeSettings(category, source, format);
    if (!decoded.ok) {
      setMessage(decoded.message);
      return;
    }
    if (category === "general" || category === "security") {
      await store.commitPrefs(mergePrefs(prefs, decoded.doc));
    }
    if (category === "general") {
      const saved = persistKeybindings(overlapCast(decoded.doc.keybindings));
      if (!saved.ok) {
        setMessage(saved.message);
        return;
      }
    }
    if (category === "connections" || category === "vaults") {
      saveSettings(mergePages(decoded.doc));
    }
    setMessage(
      settingsFields(category).length === 0 ? "Nothing to write." : "Saved.",
    );
  }

  return (
    <section className="panel set-raw">
      <div className="panel__head">
        <p className="set-raw__path">{settingsFilePath(category, format)}</p>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="Save settings"
          title="Save settings"
          onClick={() => void save()}
        >
          <IconCheck size={14} />
        </button>
      </div>
      <div className="panel__body">
        <div className="set-raw__stage">
          <pre className="set-raw__paint" aria-hidden="true">
            {paint(source)}
          </pre>
          <textarea
            className="set-raw__input"
            aria-label={settingsFilePath(category, format)}
            spellCheck={false}
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setCaret(event.target.selectionStart);
            }}
            onKeyUp={(event) => {
              if (event.currentTarget instanceof HTMLTextAreaElement) {
                setCaret(event.currentTarget.selectionStart);
              }
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                event.preventDefault();
                void save();
              }
              if (event.key === "Tab" && suggestions[0]) {
                event.preventDefault();
                insert(suggestions[0]);
              }
            }}
          />
        </div>
        {suggestions.length > 0 ? (
          <ul className="set-raw__complete" aria-label="Completions">
            {suggestions.map((suggestion) => (
              <li key={suggestion}>
                <button
                  type="button"
                  className="set-raw__option"
                  onClick={() => insert(suggestion)}
                >
                  {suggestion}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <p
          className={parsed.ok ? "hint" : "note note--err"}
          role={parsed.ok ? undefined : "alert"}
        >
          {parsed.ok ? message : parsed.message}
        </p>
      </div>
    </section>
  );
}

function readDoc(category: SettingsCategory, prefs: VaultPrefs): SettingsDoc {
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

function persistSafeBindings() {
  return { ...loadKeybindings() };
}

function mergePrefs(prefs: VaultPrefs, doc: SettingsDoc): VaultPrefs {
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

function mergePages(doc: SettingsDoc) {
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

function applySuggestion(
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

function paint(source: string) {
  return source.split("\n").map((line, index) => (
    <span key={`${index}-${line}`}>
      {paintLine(line)}
      {"\n"}
    </span>
  ));
}

function paintLine(line: string) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("#"))
    return <span className="set-raw__comment">{line}</span>;
  const sep = line.includes("=") && !line.includes(":") ? "=" : ":";
  const at = line.indexOf(sep);
  if (at < 0) return <span>{line}</span>;
  const value = line.slice(at + 1);
  return (
    <>
      <span className="set-raw__key">{line.slice(0, at)}</span>
      {sep}
      <span className={valueClass(value)}>{value}</span>
    </>
  );
}

function valueClass(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "true" || trimmed === "false") return "set-raw__bool";
  if (/^-?\d+$/.test(trimmed)) return "set-raw__num";
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return "set-raw__str";
  return "set-raw__str";
}
