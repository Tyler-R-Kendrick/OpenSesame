/**
 * Whether the unlocked shell may mount (ADR 0130).
 *
 * Unlocking moves the composition to the vault's own generation
 * (`vault:<tomb>`), and the change coordinator answers that by revoking every
 * registration of the generation before — routes, rail sections, shell
 * wrappers — and then activating the approved modules again, one at a time.
 * A shell mounted the moment the vault opens is built from the superseded
 * registrations, so it is torn down while that runs: the wrapper set changes
 * and the whole tree remounts, a route goes missing and its screen unmounts,
 * a rail section goes missing and the shell sends the person to the vault.
 * The browser-local consent popup is the sharpest case — unmounting its
 * screen closes the channel the relying party is waiting on
 * (`local_session_closed`), or drops the port it transferred.
 *
 * So the shell waits, once per unlock, for the plan that names this vault
 * and for that generation's activation pass to finish. After that it stays
 * mounted: a later generation is a real authority change and its own
 * fallbacks (`useDeniedRouteFallback`, the router's) answer it. A store that
 * has not resolved a plan has nothing to wait for, and the wait is bounded
 * (`maxWaitMs`): a module whose import stalls delays its own section, never
 * the whole vault.
 */

import {
  activatedGeneration,
  subscribeActivated,
} from "@opensesame/app-core/lib/capabilities/change.js";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useComposition } from "./capabilities.js";

export const shellReadySeams = {
  useComposition,
  activatedGeneration,
  subscribeActivated,
  maxWaitMs: 10_000,
};

const subscribe = (listener: () => void) =>
  shellReadySeams.subscribeActivated(listener);
const read = () => shellReadySeams.activatedGeneration();

export function useShellReady(
  status: string,
  tomb: string | undefined,
): boolean {
  const snapshot = shellReadySeams.useComposition();
  const activated = useSyncExternalStore(subscribe, read, read);
  const vault = status === "unlocked" ? (tomb ?? null) : undefined;
  const plan = snapshot.plan;
  const ready =
    vault !== undefined &&
    (plan === null ||
      (plan.identity.vaultId === vault && activated === snapshot.generation));
  const [opened, setOpened] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (vault === undefined) setOpened(undefined);
    else if (ready) setOpened(vault);
  }, [vault, ready]);
  useEffect(() => {
    if (vault === undefined || ready) return;
    const timer = setTimeout(() => setOpened(vault), shellReadySeams.maxWaitMs);
    return () => clearTimeout(timer);
  }, [vault, ready]);
  return ready || (vault !== undefined && opened === vault);
}
