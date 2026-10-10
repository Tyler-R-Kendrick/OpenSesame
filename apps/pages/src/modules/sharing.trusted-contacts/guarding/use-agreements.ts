/**
 * The invitations this device agreed to and has not been answered (ADR 0187
 * §10), read from the desk's pending store. They load when the panel opens,
 * when the records the desk lists change (a taken welcome changes them), and
 * whenever a step that makes or ends one calls `refresh`.
 *
 * Nothing kept here is a secret: an agreement is listed by its circle and the
 * owner's key as a short name.
 */

import {
  type Agreement,
  listAgreements,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCeremonyFailure } from "../failure-text.js";
import type { Desk } from "../use-desk.js";

export type Agreements = Readonly<{
  agreements: readonly Agreement[];
  /** The sentence for why they could not be read; empty when they were. */
  failure: string;
  refresh: () => Promise<void>;
}>;

const sameAgreements = (a: readonly Agreement[], b: readonly Agreement[]) =>
  a.length === b.length && a.every((one, i) => one.inviteId === b[i]?.inviteId);

export function useAgreements(desk: Desk): Agreements {
  const [agreements, setAgreements] = useState<readonly Agreement[]>([]);
  const failure = useCeremonyFailure("trusted-contacts:agreements", "Guarding");
  const { run } = failure;
  const latest = useRef(0);
  const refresh = useCallback(async () => {
    latest.current += 1;
    const mine = latest.current;
    const done = await run(() => listAgreements(desk.ports));
    // A slower, older read must not replace a newer one.
    if (!done.ok || mine !== latest.current) return;
    setAgreements((now) =>
      sameAgreements(now, done.value) ? now : done.value,
    );
  }, [desk.ports, run]);
  // The records are a dependency so that taking a welcome, which changes them,
  // reads the agreements again without anyone calling for it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `desk.held` is the trigger, not a value read
  useEffect(() => {
    void refresh();
  }, [refresh, desk.held]);
  return { agreements, failure: failure.message, refresh };
}
