import { type RefObject, useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "react-router";
import { clearCommandBarSearch } from "../../lib/command-bar/focus.js";
import {
  registerSearchConsumer,
  useLiveSearch,
} from "../../lib/command-bar/search.js";

/**
 * How the vault list is searched. It draws no field: the words are the
 * status-line prompt's `/?` verb, narrowing the list as they are typed there
 * (or `?q=`, which a voice or model command leaves in the address).
 *
 * `close` is stable, because the keymap registers once and calls it later.
 */
export function useVaultSearch(
  pane: RefObject<HTMLElement | null>,
  rows: RefObject<HTMLElement | null>,
) {
  const [params, setParams] = useSearchParams();
  const query = useLiveSearch() ?? params.get("q");

  const clearAddress = useRef(() => {});
  clearAddress.current = () => {
    if (!params.has("q")) return;
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("q");
        return next;
      },
      { replace: true },
    );
  };

  // A phone mounts this list under the section tree without showing it.
  useEffect(
    () =>
      registerSearchConsumer({
        // The pane, not the rows: an empty list hides its rows and is still
        // the list a search is narrowing.
        visible: () => (pane.current?.getClientRects().length ?? 0) > 0,
        focus: () => rows.current?.focus(),
      }),
    [pane, rows],
  );

  const close = useCallback(() => {
    clearCommandBarSearch();
    clearAddress.current();
  }, []);
  return { query, close };
}
