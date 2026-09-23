import { persistKeybindings } from "@opensesame/app-core/lib/configuration/nav-persist.js";
import type { SettingsCategory } from "@opensesame/app-core/lib/crumbs.js";
import {
  loadSettingsSource,
  saveSettingsSource,
} from "@opensesame/app-core/lib/settings-source.js";
import { saveSettings } from "@opensesame/app-core/lib/settings.js";
import type { VaultPrefs } from "@opensesame/app-core/lib/vault/store.js";
import {
  type RawFormat,
  type SettingsDoc,
  decodeSettings,
  encodeSettings,
  settingsFields,
  settingsFilePath,
  suggestSettings,
} from "@opensesame/app-core/sections/settings/settings-files.js";
import {
  applySuggestion,
  mergePages,
  readDoc,
  valueClass,
} from "@opensesame/app-core/sections/settings/settings-raw-editor-model.js";
import { isBoolean, isNumber, overlapCast } from "@opensesame/os-domain";
import { useEffect, useState } from "react";
import { IconCheck } from "../../components/Icons.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";

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
    // A document keeps its comments: the raw source is the stored spelling of
    // this file, and the typed projection below is what it parses to.
    setSource(
      loadSettingsSource(settingsFilePath(category, format)) ??
        encodeSettings(category, readDoc(category, prefs), format),
    );
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
    if (
      category === "connections" ||
      category === "capabilities" ||
      category === "vaults"
    ) {
      saveSettings(mergePages(decoded.doc));
    }
    // Keep the document as written: comments and ordering are the person's.
    saveSettingsSource(settingsFilePath(category, format), source);
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

export function paint(source: string) {
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
