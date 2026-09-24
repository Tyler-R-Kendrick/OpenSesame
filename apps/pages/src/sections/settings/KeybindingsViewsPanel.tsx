import { resetKeybindings } from "@opensesame/app-core/lib/configuration/keybindings.js";
import {
  currentKeybindings,
  loadKeybindings,
  loadViews,
  persistKeybindings,
  persistView,
} from "@opensesame/app-core/lib/configuration/nav-persist.js";
import { overlapCast } from "@opensesame/os-domain";
import { useState } from "react";
import { IconCheck, IconRefresh, IconStar } from "../../components/Icons.js";

export function KeybindingsViewsPanel() {
  const [bindingsText, setBindingsText] = useState(() =>
    JSON.stringify(loadKeybindings(), null, 2),
  );
  const [notice, setNotice] = useState("");
  const [viewName, setViewName] = useState("pending approvals");

  function saveBindings() {
    try {
      // SAFETY: JSON.parse of the textarea is decoded at this prefs boundary.
      const result = persistKeybindings(overlapCast(JSON.parse(bindingsText)));
      setNotice(
        result.ok
          ? "Keybindings saved. They do not run until the next key."
          : result.message,
      );
      if (result.ok) setBindingsText(JSON.stringify(result.bindings, null, 2));
    } catch {
      setNotice("Keybindings must be JSON.");
    }
  }

  function reset() {
    const next = resetKeybindings();
    persistKeybindings(next);
    setBindingsText(JSON.stringify(next, null, 2));
    setNotice(
      "Keybindings restored to defaults. Security prefs were not changed.",
    );
  }

  function pinView() {
    const result = persistView({
      id: "pending-approvals",
      name: viewName,
      collection: "approvals",
      scopeKey: "local",
      predicates: { status: "pending" },
    });
    setNotice(result.ok ? "Pinned pending-approvals view." : result.reason);
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Keybindings and views</h2>
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
        <label htmlFor="view-name">Pin approvals view</label>
        <div className="field-inline">
          <input
            id="view-name"
            value={viewName}
            onChange={(event) => setViewName(event.target.value)}
          />
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Pin view"
            title="Pin view"
            onClick={pinView}
          >
            <IconStar size={16} />
          </button>
        </div>
        <p className="hint">
          {loadViews().length} saved view(s). Effective{" "}
          {Object.keys(currentKeybindings()).length} bindings.
        </p>
        {notice ? <p className="hint">{notice}</p> : null}
      </div>
    </section>
  );
}
