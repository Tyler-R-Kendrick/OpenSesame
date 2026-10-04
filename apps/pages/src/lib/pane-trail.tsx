import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router";
import type { VaultPane } from "./vault-list-path.js";

type Entry = { key: string; pane: VaultPane };

const DEPTH: Record<VaultPane, number> = { tree: 0, list: 1, detail: 2 };

/** Goes up to a pane: back to its entry in the history, or onto `fallback`. */
export type Ascend = (pane: VaultPane, fallback: string) => void;

const AscendContext = createContext<Ascend | null>(null);

/** The key a phone's panes climb with; null where the panes are all in view. */
export function useAscend(): Ascend | null {
  return useContext(AscendContext);
}

export function AscendProvider({
  value,
  children,
}: { value: Ascend | null; children: ReactNode }) {
  return (
    <AscendContext.Provider value={value}>{children}</AscendContext.Provider>
  );
}

/**
 * The phone's own picture of its history: one entry per arrival, tagged with
 * the pane it showed.
 *
 * A drill-down is a stack, so climbing out of it has to pop the stack. The Back
 * keys used to push the pane they climbed to, which left the entry they came
 * from one press of the system Back button away: tree → list → Back put the
 * list in front of the tree again, and on Android the way out of the vault ran
 * through every pane just visited. `ascend` goes back to the nearest earlier
 * entry for the pane (past any filter switches between), and where there is
 * none (a link into the middle, a reload) it replaces the entry instead, so the
 * system Back button still leaves.
 *
 * A pop counts entries from the one the router is on, so it is only taken from
 * a screen that is that entry: the router moves before React finishes drawing
 * (a lazy pane, a transition), and a Back control still on screen for the
 * entry just left would otherwise pop one entry too far.
 *
 * Only a pane below the target climbs to it. A hidden pane's Back control can
 * still be clicked (Escape clicks the one in the pane focus was left in), and
 * from the tree that must not pop the history to whatever list was seen last.
 *
 * The mirror lives in memory and is keyed by the router's own entry keys, so it
 * needs no storage and no `window.history` internals, and it only ever learns
 * entries this session arrived at.
 */
export function usePaneTrail(pane: VaultPane): Ascend {
  const { key } = useLocation();
  const type = useNavigationType();
  const navigate = useNavigate();
  const trail = useRef<Entry[]>([]);
  const at = useRef(-1);
  const showing = useRef(pane);
  showing.current = pane;
  const drawn = useRef(key);
  drawn.current = key;

  useEffect(() => {
    const entries = trail.current;
    const here = entries.findIndex((entry) => entry.key === key);
    if (here >= 0) {
      entries[here] = { key, pane };
      at.current = here;
    } else if (type === "PUSH") {
      trail.current = [...entries.slice(0, at.current + 1), { key, pane }];
      at.current = trail.current.length - 1;
    } else if (type === "REPLACE" && at.current >= 0) {
      entries[at.current] = { key, pane };
    } else {
      trail.current = [{ key, pane }];
      at.current = 0;
    }
  }, [key, pane, type]);

  return useCallback(
    (to, fallback) => {
      if (DEPTH[showing.current] <= DEPTH[to]) return;
      // `history.state.key` is the router's own current entry (a browser
      // router writes it; a memory router has no such state to compare).
      const current: unknown = window.history.state?.key;
      if (typeof current === "string" && current !== drawn.current) return;
      for (let i = at.current - 1; i >= 0; i--) {
        if (trail.current[i]?.pane === to) {
          navigate(i - at.current);
          return;
        }
      }
      navigate(fallback, { replace: true });
    },
    [navigate],
  );
}
