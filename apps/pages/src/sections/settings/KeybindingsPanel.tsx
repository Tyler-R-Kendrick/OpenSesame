import {
  keybindingsToYaml,
  readKeybindingsYaml,
} from "@opensesame/app-core/lib/configuration/keybindings-yaml.js";
import { resetKeybindings } from "@opensesame/app-core/lib/configuration/keybindings.js";
import {
  loadKeybindings,
  persistKeybindings,
} from "@opensesame/app-core/lib/configuration/nav-persist.js";
import { overlapCast } from "@opensesame/os-domain";
import { useState } from "react";
import { IconCheck, IconRefresh } from "../../components/Icons.js";

export function KeybindingsPanel() {
  const [bindingsText, setBindingsText] = useState(() =>
    keybindingsToYaml(loadKeybindings()),
  );
  const [notice, setNotice] = useState("");

  function saveBindings() {
    const parsed = readKeybindingsYaml(bindingsText);
    if (parsed === null) {
      setNotice("Keybindings must be YAML: one key and its command per line.");
      return;
    }
    // SAFETY: the parsed file is decoded at this prefs boundary.
    const result = persistKeybindings(overlapCast(parsed));
    setNotice(
      result.ok
        ? "Keybindings saved. They do not run until the next key."
        : result.message,
    );
    if (result.ok) setBindingsText(keybindingsToYaml(result.bindings));
  }

  function reset() {
    const next = resetKeybindings();
    persistKeybindings(next);
    setBindingsText(keybindingsToYaml(next));
    setNotice(
      "Keybindings restored to defaults. Security prefs were not changed.",
    );
  }

  return (
    <section className="panel" id="settings-keybindings">
      <div className="panel__head">
        <div>
          <h2>Keybindings</h2>
        </div>
      </div>
      <div className="panel__body">
        <div className="keyed-field">
          <label htmlFor="keybindings-source">settings/keybindings.yaml</label>
          <textarea
            id="keybindings-source"
            rows={8}
            spellCheck={false}
            value={bindingsText}
            onChange={(event) => setBindingsText(event.target.value)}
          />
          <div className="actions">
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Save keybindings"
              title="Save keybindings"
              onClick={saveBindings}
            >
              <IconCheck size={16} />
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Reset keybindings"
              title="Reset keybindings"
              onClick={reset}
            >
              <IconRefresh size={16} />
            </button>
          </div>
        </div>
        {notice ? <p className="hint">{notice}</p> : null}
      </div>
    </section>
  );
}
