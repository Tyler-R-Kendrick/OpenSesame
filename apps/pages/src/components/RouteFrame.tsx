/**
 * The frame a contributed section renders in, and the choice of which
 * `gate: "any"` route renders without the unlocked shell around it. Split out
 * of `app-root.tsx` to keep that file inside the module budget.
 */

import type { RouteContribution } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { type ReactNode, useEffect, useRef } from "react";
import { matchPath, useLocation } from "react-router";
import { keyboardIsIdle, landFocus } from "../lib/focus.js";

/**
 * Scrolling frame for every section except the vault, which owns its own
 * panes. Arriving here — `g s`, a rail row, a Back — lands the keyboard on
 * the section itself, so the next Tab is the section's first control rather
 * than the top of the document; a caret a section placed on its own field
 * is left where it is.
 */
export function Framed({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const location = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: location.key is the arrival itself; the effect runs once per navigation
  useEffect(() => {
    if (keyboardIsIdle()) landFocus(ref.current);
  }, [location.key]);
  return (
    <main id="main" className="section" ref={ref} tabIndex={-1}>
      {children}
    </main>
  );
}

/**
 * A contributed route allowed on a locked device, matching this location.
 *
 * A framed one — a ceremony page a link opens (ADR 0140 §2) — renders on its
 * own only while the vault is not open; in an unlocked tab it is an ordinary
 * section of the shell, with the rail and the notifications tray around it.
 * An unframed one (a popup) always renders on its own.
 */
export function ungatedRoute(
  routes: readonly RouteContribution[],
  pathname: string,
  unlocked: boolean,
): RouteContribution | null {
  return (
    routes.find(
      (route) =>
        route.gate === "any" &&
        !(route.framed && unlocked) &&
        matchPath(route.path, pathname) !== null,
    ) ?? null
  );
}

/** An ungated route on its own page: framed routes keep their landmark. */
export function UngatedRoute({ route }: { route: RouteContribution }) {
  const Element = route.element;
  return route.framed ? (
    <Framed>
      <Element />
    </Framed>
  ) : (
    <Element />
  );
}
