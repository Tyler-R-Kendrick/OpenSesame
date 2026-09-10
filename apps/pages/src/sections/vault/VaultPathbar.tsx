import type { ReactNode } from "react";
import { showKeymapHelp } from "../../lib/keymap.js";

export function VaultPathbar({
  tomb,
  verbs,
  search,
}: {
  tomb: string;
  verbs: ReactNode;
  search: () => void;
}) {
  return (
    <div className="vtree__pathbar">
      <span className="vtree__root">
        <span className="vtree__tomb">{tomb}</span>
        <span className="vtree__sep">:/</span>
      </span>
      <fieldset className="vtree__keys" aria-label="Vault commands">
        {verbs}
        <button
          type="button"
          className="vtree__key"
          title="Search (/)"
          onClick={search}
        >
          /
        </button>
        <button
          type="button"
          className="vtree__key vtree__key--help"
          title="Keyboard shortcuts (?)"
          onClick={showKeymapHelp}
        >
          ?
        </button>
      </fieldset>
    </div>
  );
}
