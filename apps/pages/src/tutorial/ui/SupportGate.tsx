/**
 * The support capability's part of a gate (ADR 0165): a controller of its own,
 * built with no agent, and the help key in the seat the screen drew.
 *
 * It is drawn beside the screen, not around it (`GateHost`), and it holds no
 * more than the shell's does: the same sheet, the same Tutorials library read
 * through the same gate, the same tour card. What is different is what it is
 * given. The engine is built `offline`, so no agent loader is asked for
 * anything — no on-device model to download, no configured endpoint to send a
 * question to — and the guide runtime is handed a navigator that goes nowhere:
 * a gate has no section to move to, and a tour here may only point and wait.
 * Nothing is written to storage; the transcript is memory, as everywhere.
 */

import { type ReactElement, useEffect, useState } from "react";
import { type SupportHost, loadBrowserEngine } from "../engine.js";
import { useGateRoute } from "../gate-seat.js";
import { createSupportController, supportSessionSeams } from "../session.js";
import { SupportContext } from "../support-context.js";
import { SupportLauncher } from "./SupportLauncher.js";

/** Swapped by tests; the browser wiring is the default. */
export const supportGateSeams = {
  loadEngine: (host: SupportHost) => loadBrowserEngine(host, { offline: true }),
};

/** The route a gate reports until its screen has said which one it is. */
const GATE_ROUTE = "/unlock";

export function SupportGate(): ReactElement {
  const route = useGateRoute();
  const [controller] = useState(() =>
    createSupportController({
      ...supportSessionSeams,
      loadEngine: (host) => supportGateSeams.loadEngine(host),
      // The shell's controller wipes every mounted target when the vault locks.
      // A gate's controller is torn down by the unlock itself, in the same
      // commit that mounts the shell, so a wipe here would take the shell's
      // targets with it; the screens' own refs already unmount theirs.
      clearTargets: () => {},
    }),
  );

  useEffect(() => () => controller.destroy(), [controller]);

  // Subscribed here rather than at construction, like the shell's provider, so
  // React discarding a controller in StrictMode leaves no handler behind.
  useEffect(
    () => supportSessionSeams.onLock(() => controller.lock()),
    [controller],
  );

  useEffect(() => {
    controller.setRoute(route ?? GATE_ROUTE);
  }, [controller, route]);

  useEffect(() => {
    controller.setNavigator(() => {});
  }, [controller]);

  return (
    <SupportContext.Provider value={controller}>
      <SupportLauncher gate />
    </SupportContext.Provider>
  );
}
