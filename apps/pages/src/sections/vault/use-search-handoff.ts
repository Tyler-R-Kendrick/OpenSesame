import { type Dispatch, type SetStateAction, useEffect } from "react";
import { useLocation } from "react-router";

/**
 * The phone's section tree has a search key but no list of its own to search,
 * so it asks the list it jumps to for its prompt (`askForSearch()` just before
 * the navigation). A one-shot flag rather than router state: state would need
 * a second navigation to clear it, and that arrival moves the keyboard off the
 * prompt it just opened. Nothing is left in the history, so a reload or the
 * Back key never opens the prompt a second time.
 */
let asked = false;

export function askForSearch(): void {
  asked = true;
}

/**
 * Opens the list's prompt on the arrival that was asked for it, and closes it
 * when the list's pane leaves the screen for the tree. A phone keeps the list
 * mounted behind the tree, so without this a search typed there came back,
 * filter and all, the next time a tree entry opened the list: "all (3)" drew
 * no rows. An item is another pane too, but Back from it returns to the same
 * search, so only the tree ends it.
 */
export function useSearchHandoff(
  setQuery: Dispatch<SetStateAction<string | null>>,
  active = true,
): void {
  const { key } = useLocation();
  useEffect(() => {
    if (!active) setQuery(null);
  }, [active, setQuery]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: location.key is the arrival; the flag is read once per one
  useEffect(() => {
    if (!asked) return;
    asked = false;
    setQuery((current) => current ?? "");
  }, [key, setQuery]);
}
