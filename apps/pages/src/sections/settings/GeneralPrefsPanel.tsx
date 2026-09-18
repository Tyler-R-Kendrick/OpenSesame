import type { JsonValue } from "@opensesame/os-domain";
import { useEffect, useMemo, useState } from "react";
import { ModeToggle } from "../../components/configuration/ModeToggle.js";
import { SourceEditor } from "../../components/configuration/SourceEditor.js";
import {
  type EditorMode,
  applySourceEdit,
  commitPrefsSource,
  createDraft,
  parsePrefsSource,
  patchYamlTopLevel,
  prefsToYaml,
  switchDraftMode,
} from "../../lib/configuration/index.js";
import { setTheme } from "../../lib/theme.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import type { VaultPrefs } from "../../lib/vault/store.js";
import { VisualPrefs } from "./VisualPrefs.js";

const COMMENT = "# Vault preferences. Visual and Source edit this document.";

function prefsDraft(source: string, revision: number | undefined) {
  return createDraft({
    resourceKey: "client_local:vault:prefs",
    revisionToken: String(revision ?? 0),
    source,
    actorKey: "ui",
    scopeKey: "tomb",
  });
}

async function savePrefsSource(
  store: ReturnType<typeof useVaultStore>,
  prefs: VaultPrefs,
  source: string,
) {
  return commitPrefsSource(
    {
      readPrefs: () => prefs,
      tomb: () => store.activeTomb(),
      revisionToken: () => String(prefs.prefsRevision ?? 0),
      writeSemantic: async (next) => {
        await store.commitPrefs(next);
        setTheme(next.theme);
      },
      writeSource: (yaml) => store.writePrefsSource(yaml),
      readSource: () => store.readPrefsSource(),
    },
    { source, baseRevision: String(prefs.prefsRevision ?? 0) },
  );
}

export function GeneralPrefsPanel() {
  const store = useVaultStore();
  const { prefs } = useVault();
  const [mode, setMode] = useState<EditorMode>("visual");
  const [notice, setNotice] = useState("");
  const initial = useMemo(() => prefsToYaml(prefs, COMMENT), [prefs]);
  const [source, setSource] = useState(initial);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read authored YAML when prefsRevision advances
  useEffect(() => {
    let cancelled = false;
    void store.readPrefsSource().then((authored) => {
      if (!cancelled && authored) setSource(authored);
    });
    return () => {
      cancelled = true;
    };
  }, [store, prefs.prefsRevision]);
  const parsed = parsePrefsSource(source);
  const draftPrefs: VaultPrefs = parsed.ok
    ? { ...parsed.value, prefsRevision: prefs.prefsRevision }
    : prefs;

  const setModeAndKeepBytes = (next: EditorMode) => {
    const draft = prefsDraft(source, prefs.prefsRevision);
    setSource(switchDraftMode(draft, next).currentSource);
    setMode(next);
  };
  const visualPatch = (key: string, value: JsonValue) => {
    const patched = patchYamlTopLevel(source, key, value);
    const draft = prefsDraft(source, prefs.prefsRevision);
    setSource(applySourceEdit(draft, patched, []).currentSource);
  };
  const save = () => {
    void savePrefsSource(store, prefs, source).then((r) =>
      setNotice(r.message),
    );
  };

  return (
    <>
      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>Preferences</h2>
          </div>
          <ModeToggle
            mode={mode}
            onMode={setModeAndKeepBytes}
            dirty={source !== initial}
          />
        </div>
        <div className="panel__body">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void save()}
            disabled={!parsed.ok}
          >
            Save preferences
          </button>
          {notice ? <p className="hint">{notice}</p> : null}
        </div>
      </section>
      {mode === "source" ? (
        <section className="panel">
          <div className="panel__body">
            <SourceEditor
              id="prefs-source"
              value={source}
              diagnostics={parsed.ok ? [] : parsed.diagnostics}
              onChange={setSource}
              onSave={() => void save()}
            />
            <p className="hint">
              {parsed.ok
                ? "Source and Visual share this draft. Save writes the vault preference store."
                : "Invalid source stays editable. Visual controls are paused until this parses."}
            </p>
          </div>
        </section>
      ) : parsed.ok ? (
        <VisualPrefs
          prefs={draftPrefs}
          onTheme={(id) => visualPatch("theme", id)}
          onNumber={(key, value) => visualPatch(key, value)}
          onToggle={(key, value) => visualPatch(key, value)}
        />
      ) : (
        <p role="alert" className="note note--err">
          Visual editing is paused until Source parses. Last valid values are
          not substituted.
        </p>
      )}
    </>
  );
}
