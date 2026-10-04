/**
 * The `/` search command used by every listing.
 *
 * Search is the status-line prompt's `/?` verb. A listing does not draw a key
 * or a field for it: it narrows to the words the prompt holds while it is
 * mounted, `/` writes the verb into the prompt, and Escape empties it.
 */

import { useEffect } from "react";
import {
  clearCommandBarSearch,
  searchInCommandBar,
} from "../lib/command-bar/focus.js";
import {
  registerSearchConsumer,
  useLiveSearch,
} from "../lib/command-bar/search.js";
import { registerSearchKeymap } from "../lib/keymap.js";

export function useListingSearch() {
  // `null` while the prompt holds anything else, `""` before the first word.
  const query = useLiveSearch();
  useEffect(
    () =>
      registerSearchKeymap({
        search: searchInCommandBar,
        closeSearch: clearCommandBarSearch,
      }),
    [],
  );
  useEffect(() => registerSearchConsumer({ visible: () => true }), []);
  return { query, open: searchInCommandBar, close: clearCommandBarSearch };
}
