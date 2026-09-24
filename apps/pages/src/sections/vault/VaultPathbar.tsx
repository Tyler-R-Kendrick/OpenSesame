import type { ReactNode } from "react";
import { CrumbTrail, useCrumbs } from "../../components/Crumbs.js";
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
 *
 * What it opens with instead is where the page is — `Vault › Logins`,
 * `Vault › Work › Webmail`. Left to the shell, that path was a row over both
 * panes that came and went with the route, moving the list and the editor
 * 24px each time, and this strip held three keys and nothing they belonged to.
 */
export function VaultPathbar({
  verbs,
  search,
}: {
  verbs: ReactNode;
  search: () => void;
}) {
  const crumbs = useCrumbs();
  return (
    <div className="vtree__pathbar">
      <CrumbTrail
        crumbs={crumbs}
        className="vtree__crumbs"
        label="Vault path"
      />
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
