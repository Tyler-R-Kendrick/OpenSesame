/**
 * Where a plugin tile takes the code `opensesame plugins pair --origin …`
 * printed on the daemon's machine (ADR 0150 §7): one field and one icon key,
 * as the tailnet drive pairs. The code is traded once for this page's own
 * key; a refusal shows in the tile's mark, never in a box.
 */

import type { PluginSession } from "@opensesame/app-core/lib/plugins/session.js";
import { useState, useSyncExternalStore } from "react";
import { IconConnection } from "../../../components/Icons.js";

const ACTION = "Pair with the daemon";

export function PairForm({ session }: { session: PluginSession }) {
  const view = useSyncExternalStore(session.subscribe, session.view);
  const [code, setCode] = useState("");
  const id = `plugin-pair-${session.plugin.id}`;
  const open = session.canPair();
  return (
    <form
      className="plugin-tile__pair"
      onSubmit={(event) => {
        event.preventDefault();
        void session.pair(code);
      }}
    >
      <label htmlFor={id}>Pairing code</label>
      <div className="field-inline">
        <input
          id={id}
          type="text"
          value={code}
          placeholder="opensesame-plugins:v1:…"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={view.busy || !open}
          onChange={(event) => setCode(event.target.value)}
        />
        <button
          type="submit"
          className="icon-btn"
          disabled={view.busy || !open || code.trim().length === 0}
          aria-label={ACTION}
          title={ACTION}
        >
          <IconConnection size={16} />
        </button>
      </div>
    </form>
  );
}
