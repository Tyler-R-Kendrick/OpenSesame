import { persistKeybindings } from "@opensesame/app-core/lib/configuration/nav-persist.js";
import {
  loadSettingsSource,
  saveSettingsSource,
} from "@opensesame/app-core/lib/settings-source.js";
import { saveSettings } from "@opensesame/app-core/lib/settings.js";
import {
  listAvailableUnlockMethods,
  listSecondSteps,
} from "@opensesame/app-core/lib/vault/unlock-methods.js";
import { reconcileSource } from "@opensesame/app-core/sections/settings/settings-config.js";
import {
  decodeSettings,
  settingsFields,
  settingsFilePath,
  suggestSettings,
} from "@opensesame/app-core/sections/settings/settings-files.js";
import {
  type SettingsState,
  applySuggestion,
  mergePages,
  mergePrefs,
  readDoc,
  valueClass,
} from "@opensesame/app-core/sections/settings/settings-raw-editor-model.js";
import { overlapCast } from "@opensesame/os-domain";
import { useMemo, useState } from "react";
import { useComposition } from "../../bindings/capabilities.js";
import { IconCheck } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useSettingsEpoch } from "../../lib/use-settings.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";

/** Everything the settings pages show, read live so the file follows them. */
function useSettingsState(): SettingsState {
  const { prefs, header } = useVault();
  const composition = useComposition();
  const plan = composition.plan?.capabilities;
  return useMemo(
    () => ({
      prefs,
      unlockMethods: listAvailableUnlockMethods(header),
      secondSteps: listSecondSteps(header),
      approvedCapabilities: Object.entries(plan ?? {})
        .filter(([, state]) => state?.approved)
        .map(([id]) => id)
        .sort(),
    }),
    [prefs, header, plan],
  );
}

/**
 * A settings directory's `config.yaml`. The file and the page are one set of
 * values: it opens saying what the page says (keeping the person's comments),
 * and a save writes the page — so a change in either shows in both.
 */
export function SettingsRawEditor({ category }: { category: string }) {
  const store = useVaultStore();
  const state = useSettingsState();
  // Stored settings (endpoints, the active project) re-render the file too.
  useSettingsEpoch();
  const path = settingsFilePath(category);
  const current = readDoc(category, state);
  const derived = reconcileSource(category, loadSettingsSource(path), current);
  const [draft, setDraft] = useState<{ path: string; text: string } | null>(
    null,
  );
  const [caret, setCaret] = useState(0);
  const [message, setMessage] = useState("");
  const source = draft?.path === path ? draft.text : derived;
  const dirty = source !== derived;

  const suggestions = suggestSettings(category, source, caret).slice(0, 8);
  const parsed = decodeSettings(category, source, current);

  function edit(text: string) {
    setDraft({ path, text });
    setMessage("");
  }

  async function save() {
    const decoded = decodeSettings(category, source, current);
    if (!decoded.ok) return;
    if (category === "general") {
      await store.commitPrefs(mergePrefs(state.prefs, decoded.doc));
      const saved = persistKeybindings(overlapCast(decoded.doc.keybindings));
      if (!saved.ok) {
        setMessage(saved.message);
        return;
      }
    }
    if (category === "connections" || category === "vaults") {
      saveSettings(mergePages(decoded.doc));
    }
    // Keep the document as written: comments and ordering are the person's.
    saveSettingsSource(path, source);
    setDraft(null);
    const writable = settingsFields(category).some((field) => !field.readonly);
    setMessage(writable ? "written" : "read-only");
  }

  const status = parsed.ok ? message : parsed.message;
  const lines = source.split("\n").length - (source.endsWith("\n") ? 1 : 0);

  return (
    <section className="panel set-raw">
      <div className="panel__head">
        <p className="set-raw__path">{path}</p>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label={`Write ${path}`}
          title={`Write ${path} (Ctrl-S)`}
          disabled={!parsed.ok}
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
            aria-label={path}
            aria-invalid={parsed.ok ? undefined : true}
            spellCheck={false}
            value={source}
            onChange={(event) => {
              edit(event.target.value);
              setCaret(event.target.selectionStart);
            }}
            onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                event.preventDefault();
                void save();
              }
              if (event.key === "Tab" && suggestions[0]) {
                event.preventDefault();
                edit(applySuggestion(source, caret, suggestions[0]));
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
                  onClick={() =>
                    edit(applySuggestion(source, caret, suggestion))
                  }
                >
                  {suggestion}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <output className="set-raw__status" aria-live="polite">
          {parsed.ok ? null : <StatusMark tone="err" label={parsed.message} />}
          <span className="set-raw__status-text">
            {status || (dirty ? "modified" : "")}
          </span>
          <span className="set-raw__status-meta">
            {dirty ? "[+] " : ""}
            {lines}L
          </span>
        </output>
      </div>
    </section>
  );
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
  if (line.trimStart().startsWith("#"))
    return <span className="set-raw__comment">{line}</span>;
  const at = line.indexOf(":");
  if (at < 0) return <span>{line}</span>;
  const rest = line.slice(at + 1);
  const hash = rest.search(/\s#/);
  const value = hash < 0 ? rest : rest.slice(0, hash);
  const comment = hash < 0 ? "" : rest.slice(hash);
  return (
    <>
      <span className="set-raw__key">{line.slice(0, at)}</span>:
      <span className={valueClass(value)}>{value}</span>
      {comment ? <span className="set-raw__comment">{comment}</span> : null}
    </>
  );
}
