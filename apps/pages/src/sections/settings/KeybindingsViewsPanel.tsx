import { overlapCast } from "@opensesame/os-domain";
import { useState } from "react";
import { resetKeybindings } from "../../lib/configuration/keybindings.js";
import {
  currentKeybindings,
  loadKeybindings,
  loadViews,
  persistKeybindings,
  persistView,
} from "../../lib/configuration/nav-persist.js";

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
        <p className="hint">
          Bindings are inert action ids. Imported maps never run immediately.
          Saved views are queries, not grants.
        </p>
        <label htmlFor="keybindings-source">settings/keybindings.yaml</label>
        <textarea
          id="keybindings-source"
          rows={8}
          spellCheck={false}
          value={bindingsText}
          onChange={(event) => setBindingsText(event.target.value)}
        />
        <button type="button" className="btn btn--sm" onClick={saveBindings}>
          Save keybindings
        </button>
        <button type="button" className="btn btn--sm" onClick={reset}>
          Reset keybindings
        </button>
        <label htmlFor="view-name">Pin approvals view</label>
        <input
          id="view-name"
          value={viewName}
          onChange={(event) => setViewName(event.target.value)}
        />
        <button type="button" className="btn btn--sm" onClick={pinView}>
          Pin view
        </button>
        <p className="hint">
          {loadViews().length} saved view(s). Effective{" "}
          {Object.keys(currentKeybindings()).length} bindings.
        </p>
        {notice ? <p className="hint">{notice}</p> : null}
      </div>
    </section>
  );
}
