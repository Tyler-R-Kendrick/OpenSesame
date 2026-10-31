import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import {
  useHref,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router";
import type { VaultPane } from "./vault-list-path.js";

type Entry = { key: string; route: string; pane: VaultPane };

const DEPTH = { tree: 0, list: 1, detail: 2 } as const satisfies Record<
  VaultPane,
  number
>;

/** Goes up to a pane: back to its entry in the history, or onto `fallback`. */
export type Ascend = (pane: VaultPane, fallback: string) => void;

const AscendContext = createContext<Ascend | null>(null);

type PaneOwner = symbol;
type PendingTraversal = {
  owner: PaneOwner | null;
  targetKey: string;
  targetRoute: string;
  arrived: boolean;
  resume: (() => void) | null;
  stop: () => void;
};
let pendingTraversal: PendingTraversal | null = null;

/** A section jump follows the current native Back, with the latest jump winning. */
export function afterPaneTraversal(run: () => void): boolean {
  if (!pendingTraversal) return false;
  pendingTraversal.resume = run;
  return true;
}

function retainTraversal(owner: PaneOwner, target: Entry): PendingTraversal {
  const onPop = (event: PopStateEvent) => {
    const state: BoundaryValue = event.state;
    const key =
      isJsonObject(state) && isString(state.key) ? state.key : "default";
    const route = window.location.href;
    if (key !== pending.targetKey || route !== pending.targetRoute) return;
    pending.stop();
    pending.arrived = true;
    if (pendingTraversal === pending && !pending.owner && !pending.resume)
      pendingTraversal = null;
  };
  const pending: PendingTraversal = {
    owner,
    targetKey: target.key,
    targetRoute: target.route,
    arrived: false,
    resume: null,
    stop: () => window.removeEventListener("popstate", onPop, true),
  };
  window.addEventListener("popstate", onPop, true);
  return pending;
}

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
  const location = useLocation();
  const { key } = location;
  const route = new URL(useHref(location), window.location.href).href;
  const type = useNavigationType();
  const navigate = useNavigate();
  const trail = useRef<Entry[]>([]);
  const at = useRef(-1);
  const showing = useRef(pane);
  showing.current = pane;
  const drawn = useRef(key);
  drawn.current = key;
  const owner = useRef(Symbol("pane traversal owner"));

  useLayoutEffect(() => {
    const identity = owner.current;
    if (pendingTraversal?.owner === null) pendingTraversal.owner = identity;
    return () => {
      if (pendingTraversal?.owner === identity) {
        if (pendingTraversal.arrived) {
          pendingTraversal.stop();
          pendingTraversal = null;
        } else {
          pendingTraversal.owner = null;
          pendingTraversal.resume = null;
        }
      }
    };
  }, []);

  useEffect(() => {
    const entries = trail.current;
    const here = entries.findIndex(
      (entry) => entry.key === key && entry.route === route,
    );
    if (here >= 0) {
      entries[here] = { key, route, pane };
      at.current = here;
    } else if (type === "PUSH") {
      trail.current = [
        ...entries.slice(0, at.current + 1),
        { key, route, pane },
      ];
      at.current = trail.current.length - 1;
    } else if (type === "REPLACE" && at.current >= 0) {
      entries[at.current] = { key, route, pane };
    } else {
      trail.current = [{ key, route, pane }];
      at.current = 0;
    }
    const pending = pendingTraversal;
    if (
      pending?.owner === owner.current &&
      (pending.arrived ||
        (pending.targetKey === key &&
          pending.targetRoute === route &&
          type === "POP"))
    ) {
      pendingTraversal = null;
      pending.stop();
      pending.resume?.();
    }
  }, [key, route, pane, type]);

  return useCallback(
    (to, fallback) => {
      // Native history traversal is asynchronous: two Escapes can otherwise
      // enqueue two pops while both still see the same rendered entry.
      if (pendingTraversal) return;
      if (DEPTH[showing.current] <= DEPTH[to]) return;
      // `history.state.key` is the router's own current entry (a browser
      // router writes it; a memory router has no such state to compare).
      const current: BoundaryValue = window.history.state?.key;
      if (isString(current) && current !== drawn.current) return;
      for (let i = at.current - 1; i >= 0; i--) {
        if (trail.current[i]?.pane === to) {
          const pending = retainTraversal(owner.current, trail.current[i]);
          pendingTraversal = pending;
          try {
            navigate(i - at.current);
          } catch (error) {
            pending.stop();
            if (pendingTraversal === pending) pendingTraversal = null;
            throw error;
          }
          return;
        }
      }
      navigate(fallback, { replace: true });
    },
    [navigate],
  );
}
