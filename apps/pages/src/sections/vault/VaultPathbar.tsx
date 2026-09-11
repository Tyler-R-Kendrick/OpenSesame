import type { ReactNode } from "react";
import { SlashSearchKey } from "../../components/SlashSearch.js";
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
        <SlashSearchKey onOpen={search} />
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
