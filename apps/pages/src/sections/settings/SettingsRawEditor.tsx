import {
  loadKeymap,
  saveKeymapData,
  subscribeKeymap,
} from "@opensesame/app-core/lib/keymap/store.js";
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
  type SettingsDoc,
  decodeSettings,
  legacySettingsFilePath,
  settingsFields,
  settingsFilePath,
  suggestSettings,
} from "@opensesame/app-core/sections/settings/settings-files.js";
import {
  MAX_SUGGESTIONS,
  type SettingsState,
  applySuggestion,
  completeAt,
  keymapData,
  mergePages,
  mergePrefs,
  readDoc,
  tabSuggestion,
} from "@opensesame/app-core/sections/settings/settings-raw-editor-model.js";
import { overlapCast } from "@opensesame/os-domain";
import {
  type KeyboardEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useComposition } from "../../bindings/capabilities.js";
import { FailureNotice } from "../../components/FailureNotice.js";
import { useSettingsEpoch } from "../../lib/use-settings.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import { Status, WriteButton } from "./SettingsRawEditorParts.js";
import { PaintedText } from "./files/PaintedText.js";

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
 * Tab completes a half-typed word and otherwise moves focus, as it always
 * does: a person must be able to Tab out of the file (ADR 0156). It applies
 * only once they have typed in the file since it took focus, with the caret at
 * the end of a partly typed key or value that a suggestion goes on to finish.
 */
function useTabCompletion(
  category: string,
  source: string,
  edit: (text: string) => void,
) {
  const input = useRef<HTMLTextAreaElement>(null);
  const edited = useRef(false);
  const caretTo = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = caretTo.current;
    caretTo.current = null;
    if (at !== null) input.current?.setSelectionRange(at, at);
  });
  function onTab(event: KeyboardEvent<HTMLTextAreaElement>): void {
    const { selectionStart, selectionEnd } = event.currentTarget;
    const bare = !(
      event.shiftKey ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey
    );
    if (!edited.current || !bare || selectionStart !== selectionEnd) return;
    const words = suggestSettings(category, source, selectionStart);
    const suggestion = tabSuggestion(source, selectionStart, words);
    if (suggestion === null) return;
    event.preventDefault();
    const done = completeAt(source, selectionStart, suggestion);
    caretTo.current = done.caret;
    edit(done.source);
  }
  return { input, edited, onTab };
}

/** What a save writes besides the file's own text; a refusal to say, or null. */
function commit(category: string, doc: SettingsDoc): string | null {
  if (category === "keybindings") {
    const saved = saveKeymapData(overlapCast(keymapData(doc)));
    if (!saved.ok) return saved.message;
  }
  if (
    category === "connections" ||
    category === "capabilities" ||
    category === "vaults"
  ) {
    saveSettings(mergePages(doc));
  }
  return null;
}

function Completions({
  words,
  onPick,
}: {
  words: readonly string[];
  onPick: (word: string) => void;
}) {
  if (words.length === 0) return null;
  return (
    <ul className="set-raw__complete" aria-label="Completions">
      {words.map((word) => (
        <li key={word}>
          <button
            type="button"
            className="set-raw__option"
            onClick={() => onPick(word)}
          >
            {word}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * What the last save said. A refusal is an operation that failed: it goes to
 * the tray, keyed by the file, and the status wears its mark. Live validation
 * of the draft is only state, so it never reaches the tray (ADR 0163).
 */
function useSaveResult(path: string) {
  const [result, setResult] = useState<{
    path: string;
    text: string;
    refused: boolean;
  } | null>(null);
  // A result belongs to the file it was written for: the editor stays mounted
  // when the category changes, and another file never wears this one's refusal.
  const mine = result?.path === path ? result : null;
  return {
    refusal: mine?.refused ? mine.text : null,
    message: mine && !mine.refused ? mine.text : "",
    setResult,
  };
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
  // …and so does a key recorded on the Keymap panel.
  useSyncExternalStore(subscribeKeymap, loadKeymap, loadKeymap);
  const path = settingsFilePath(category);
  const current = readDoc(category, state);
  const derived = reconcileSource(
    category,
    loadSettingsSource(path) ??
      loadSettingsSource(legacySettingsFilePath(category)),
    current,
  );
  const [draft, setDraft] = useState<{ path: string; text: string } | null>(
    null,
  );
  const [caret, setCaret] = useState(0);
  const { refusal, message, setResult } = useSaveResult(path);
  const source = draft?.path === path ? draft.text : derived;
  const dirty = source !== derived;

  // Narrowed by what is typed first, then capped: a later command is reached
  // by typing more of it.
  const suggestions = suggestSettings(category, source, caret).slice(
    0,
    MAX_SUGGESTIONS,
  );
  const parsed = decodeSettings(category, source, current);

  function edit(text: string) {
    setDraft({ path, text });
    setResult(null);
  }
  const tab = useTabCompletion(category, source, edit);

  async function save() {
    const decoded = decodeSettings(category, source, current);
    if (!decoded.ok) return;
    if (category === "general") {
      await store.commitPrefs(mergePrefs(state.prefs, decoded.doc));
    }
    const refused = commit(category, decoded.doc);
    if (refused !== null) {
      setResult({ path, text: refused, refused: true });
      return;
    }
    // Keep the document as written: comments and ordering are the person's.
    saveSettingsSource(path, source);
    setDraft(null);
    const writable = settingsFields(category).some((field) => !field.readonly);
    setResult({
      path,
      text: writable ? "written" : "read-only",
      refused: false,
    });
  }

  return (
    <section className="panel set-raw">
      <div className="panel__head">
        <p className="set-raw__path">{path}</p>
        <WriteButton
          path={path}
          disabled={!parsed.ok}
          onWrite={() => void save()}
        />
      </div>
      <div className="panel__body">
        <FileInput
          path={path}
          source={source}
          invalid={!parsed.ok}
          tab={tab}
          onEdit={edit}
          onCaret={setCaret}
          onSave={() => void save()}
        />
        <Completions
          words={suggestions}
          onPick={(word) => edit(applySuggestion(source, caret, word))}
        />
        <Status
          source={source}
          dirty={dirty}
          problem={parsed.ok ? null : parsed.message}
          refusal={refusal}
          message={message}
        />
        <FailureNotice
          id={`settings-file:${path}`}
          title="Settings file"
          message={refusal}
        />
      </div>
    </section>
  );
}

/** The file's text, painted beneath a textarea that owns the keys. */
function FileInput({
  path,
  source,
  invalid,
  tab,
  onEdit,
  onCaret,
  onSave,
}: {
  path: string;
  source: string;
  invalid: boolean;
  tab: ReturnType<typeof useTabCompletion>;
  onEdit: (text: string) => void;
  onCaret: (caret: number) => void;
  onSave: () => void;
}) {
  return (
    <PaintedText
      language="yaml"
      path={path}
      source={source}
      invalid={invalid}
      inputRef={tab.input}
      onFocus={() => {
        tab.edited.current = false;
      }}
      onChange={(text, caret) => {
        tab.edited.current = true;
        onEdit(text);
        onCaret(caret);
      }}
      onKeyUp={onCaret}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "s") {
          event.preventDefault();
          onSave();
        }
        if (event.key === "Tab") tab.onTab(event);
      }}
    />
  );
}
