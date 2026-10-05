/**
 * The seat a gate screen keeps for the help key (ADR 0166).
 *
 * The screens in front of the shell — the front door, unlock, setup, join, the
 * broker popup and the federation return — have no statusline for the Support
 * mark to sit in. Each draws one `GateHelpSeat` in its own chrome row, beside
 * the keys it already has, and `GateHost` holds the seat and the route the
 * screen declares (`useSupportRoute`) for whoever draws the key.
 *
 * This file is **core**: it imports React and the route context and nothing of
 * the support capability, so a build that excludes `support.guided-help` draws
 * an empty seat that is zero pixels wide. The capability's own part of the gate
 * (`tutorial/ui/SupportGate.tsx`) is drawn *beside* the screen,
 * never around it, so it arriving or leaving cannot remount the screen — a
 * screen that remounted would lose what a person had typed into it.
 */

import type { ShellWrapperContribution } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import type { GuideRouteId } from "@opensesame/app-core/tutorial/registry/routes.js";
import {
  type ReactElement,
  type ReactNode,
  createContext,
  useContext,
  useMemo,
  useState,
} from "react";
import { useTabSwipe } from "../lib/use-tab-swipe.js";
import { SupportRouteOverrideContext } from "./session.js";
import "./gate-seat.css";

type Seat = {
  readonly node: HTMLElement | null;
  readonly place: (node: HTMLElement | null) => void;
};

const SeatContext = createContext<Seat>({ node: null, place: () => {} });
const RouteContext = createContext<GuideRouteId | null>(null);

/** An empty seat in a screen's chrome row. The help key is portalled into it. */
export function GateHelpSeat(): ReactElement {
  const { place } = useContext(SeatContext);
  return <span ref={place} className="gate-seat" />;
}

/** The seat the screen on show has drawn, or null while it has drawn none. */
export function useGateSeat(): HTMLElement | null {
  return useContext(SeatContext).node;
}

/** The route the screen on show declared with `useSupportRoute`, if any. */
export function useGateRoute(): GuideRouteId | null {
  return useContext(RouteContext);
}

/**
 * Around every screen that is not the unlocked shell. It always wraps the
 * screen in the same two providers, whatever the capabilities, and puts what a
 * capability contributed as its `Gate` beside it.
 */
export function GateHost({
  wrappers,
  children,
}: {
  wrappers: readonly ShellWrapperContribution[];
  children: ReactNode;
}): ReactElement {
  // Every gate screen (the door, setup, unlock, the federation return) turns
  // its tabs on a sideways swipe; the shell does the same from `AppShell`.
  useTabSwipe();
  const [node, place] = useState<HTMLElement | null>(null);
  const [route, setRoute] = useState<GuideRouteId | null>(null);
  const seat = useMemo(() => ({ node, place }), [node]);
  const gates = [...wrappers]
    .filter((entry) => entry.Gate !== undefined)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return (
    <SupportRouteOverrideContext.Provider value={setRoute}>
      <SeatContext.Provider value={seat}>
        {children}
        <RouteContext.Provider value={route}>
          {gates.map((entry) =>
            entry.Gate ? <entry.Gate key={entry.id} /> : null,
          )}
        </RouteContext.Provider>
      </SeatContext.Provider>
    </SupportRouteOverrideContext.Provider>
  );
}
