/**
 * Where a plugin tile takes the code `opensesame plugins pair --origin …`
 * printed on the daemon's machine (ADR 0150 §7): one field and one icon key,
 * as the tailnet drive pairs. The code is traded once for this page's own
 * key; a refusal shows in the tile's mark, never in a box.
 */

import type { PluginSession } from "@opensesame/app-core/lib/plugins/session.js";
import { type RefObject, useState, useSyncExternalStore } from "react";
import { IconConnection } from "../../../components/Icons.js";
import { useVault } from "../../../lib/vault/hooks.js";
import { useFocusHandoff } from "./useFocusHandoff.js";

const ACTION = "Pair with the daemon";

/**
 * A row acts, or it is not drawn (ADR 0150): with no open vault to keep the
 * key in there is no field, and the key appears once there is a code to send.
 * Neither is ever disabled, so focus is never on a key that went dead.
 */
export function PairForm({
  session,
  home,
}: {
  session: PluginSession;
  home: RefObject<HTMLElement | null>;
}) {
  const view = useSyncExternalStore(session.subscribe, session.view);
  useVault();
  const [code, setCode] = useState("");
  const field = useFocusHandoff<HTMLInputElement>(home);
  const key = useFocusHandoff<HTMLButtonElement>(home);
  if (!session.canPair()) return null;
  const id = `plugin-pair-${session.plugin.id}`;
  const ready = code.trim().length > 0;
  return (
    <form
      className="plugin-tile__pair"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) void session.pair(code);
      }}
    >
      <label htmlFor={id}>Pairing code</label>
      <div className="field-inline">
        <input
          ref={field}
          id={id}
          type="text"
          value={code}
          placeholder="opensesame-plugins:v1:…"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          readOnly={view.busy}
          onChange={(event) => setCode(event.target.value)}
        />
        {ready ? (
          <button
            ref={key}
            type="submit"
            className="icon-btn"
            aria-busy={view.busy || undefined}
            aria-label={ACTION}
            title={ACTION}
          >
            <IconConnection size={16} />
          </button>
        ) : null}
      </div>
    </form>
  );
}
