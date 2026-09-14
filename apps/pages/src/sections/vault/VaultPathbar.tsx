import type { ReactNode } from "react";
import { SlashSearchKey } from "../../components/SlashSearch.js";
import { showKeymapHelp } from "../../lib/keymap.js";

/**
 * The list pane's command row.
 *
 * It used to open with `personal:/` as well, which the pane's own status line
 * already says at the foot — and says better: that one follows the cursor, so
 * it reads `personal:/Work/Webmail` where this one never left the root, and it
 * carries the count and the filter beside it. One tomb path per pane, in the
 * place that says the most about it.
 */
export function VaultPathbar({
  verbs,
  search,
}: {
  verbs: ReactNode;
  search: () => void;
}) {
  return (
    <div className="vtree__pathbar">
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
